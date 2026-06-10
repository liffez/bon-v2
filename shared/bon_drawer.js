/**
 * shared/bon_drawer.js
 * ════════════════════════════════════════════════════════════
 * Bon-detalje drawer — glider ind fra højre.
 * Fuld redigering af alle felter. URL-synkroniseret.
 *
 * Kræver: utils.js, api.js, kunde_soeg.js, BonConfig.js (alle globale scripts)
 *
 * Brug:
 *   const drawer = new BonDrawer();
 *   drawer.load(bonId);
 *   drawer.show();
 * ════════════════════════════════════════════════════════════
 */

/**
 * Åbn delivery-note popout-vindue for en bon.
 * Erstatter den gamle openManualBookingModal — popout giver felt-for-felt
 * kopiering ved siden af leverandørens hjemmeside.
 *
 * Target-navn pr. bon, så flere bookings kan håndteres parallelt
 * (fx weekend hvor kontoret batcher 5 bookings). Klik på samme bon
 * to gange genbruger eksisterende vindue.
 */
function openDeliveryNote(bonId, vehicleId) {
    if (!bonId) {
        console.warn('[openDeliveryNote] bonId påkrævet');
        return;
    }
    const url = '/delivery/note/' + bonId + (vehicleId ? '?vehicle=' + vehicleId : '');
    const win = window.open(
        url,
        'rr-delivery-note-' + bonId,
        'width=420,height=780,left=100,top=100,scrollbars=yes,resizable=yes,toolbar=no,location=no,menubar=no'
    );
    if (!win) {
        // Popup blokeret — vis besked med direkte link så bruger kan åbne manuelt
        const msg = 'Din browser blokerede popup-vinduet. Tillad popups for dette site, eller åbn siden i en ny fane.';
        if (typeof showModal === 'function') {
            showModal({
                title: 'Popup blokeret',
                bodyHtml: '<p>' + msg + '</p><p><a href="' + url + '" target="_blank" rel="noopener">Åbn bestillings-note i ny fane</a></p>'
            });
        } else {
            alert(msg + '\n\nÅbn manuelt: ' + url);
        }
        return null;
    }
    win.focus();
    return win;
}
window.openDeliveryNote = openDeliveryNote;

class BonDrawer {
    constructor() {
        this.bonId = null;
        this.data = null;
        this.dirty = false;
        this.priceCategories = [];
        this.paymentTypes = [];
        this._mailVars = {};
        this._mailTemplates = null;
        this._buildDOM();
        this._loadDropdowns();
        this._bindSSE();
        _drawerInstance = this; // Global reference for drawer mail helpers

        // Flag-strip (påmindelser fra kunde/firma — CLAUDE_KUNDE_FLAGS.md)
        if (typeof FlagStrip !== 'undefined') {
            this.flagStrip = new FlagStrip(this.el.querySelector('.drawer-flags'), {
                bonId: null,
                onChange: () => this.load(this.bonId),
            });
        }
    }

    /* ══════════════════════════════════════════════════════
       DOM
       ══════════════════════════════════════════════════════ */

    _buildDOM() {
        // Overlay
        this.overlayEl = document.createElement('div');
        this.overlayEl.className = 'bon-drawer-overlay';

        // Drawer
        this.el = document.createElement('div');
        this.el.className = 'bon-drawer';

        // Kvartersintervaller
        const timeOpts = ['<option value="">--:--</option>'];
        for (let h = 6; h <= 22; h++) {
            for (let m = 0; m < 60; m += 15) {
                const t = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
                timeOpts.push(`<option value="${t}">${t}</option>`);
            }
        }
        const timeHtml = timeOpts.join('');

        this.el.innerHTML = `
            <div class="drawer-header">
                <span class="drawer-title">Bon #---</span>
                <div class="drawer-header-actions">
                    <button class="drawer-flyver" type="button" title="Send flyver til køkkenet">✈ Flyver</button>
                    <button class="drawer-copy" type="button" title="Kopiér bon — opretter ny bon med samme indhold og status NY">⎘ Kopiér</button>
                    <button class="drawer-history" type="button" title="Vis historik">⏱ Historik</button>
                    <button class="drawer-close" type="button">&times;</button>
                </div>
            </div>

            <!-- Påmindelser fra kunde/firma (CLAUDE_KUNDE_FLAGS.md) -->
            <div class="drawer-flags"></div>

            <div class="drawer-body">
                <!-- STATUS -->
                <div class="drawer-section">
                    <div class="drawer-status-bar"></div>
                    <div class="drawer-status-hint">Status gemmes automatisk når du klikker en knap. Brug "Gem" nederst til de øvrige felter.</div>
                </div>

                <!-- LEVERING -->
                <div class="drawer-section" data-drawer-section="levering">
                    <label class="drawer-label">Levering</label>
                    <div class="drawer-row">
                        <input type="date" class="drawer-field" data-field="delivery_date">
                        <select class="drawer-field" data-field="delivery_time">${timeHtml}</select>
                    </div>
                    <div class="drawer-row">
                        <label class="drawer-sublabel">Pickup-tid</label>
                        <select class="drawer-field drawer-half" data-field="pickup_time">${timeHtml}</select>
                    </div>
                    <label class="drawer-sublabel">Type</label>
                    <div class="drawer-type-toggle">
                        <button type="button" class="drawer-type" data-type="delivery">Levering</button>
                        <button type="button" class="drawer-type" data-type="pickup">Afhentning</button>
                        <button type="button" class="drawer-type" data-type="event">Event</button>
                    </div>
                    <div class="drawer-delivery-fields">
                        <label class="drawer-sublabel">Adresse</label>
                        <input type="text" class="drawer-field drawer-dawa-input" placeholder="Søg adresse..." autocomplete="off">
                        <div class="drawer-dawa-results"></div>
                        <div class="drawer-address-display" style="display:none"></div>
                        <label class="drawer-sublabel">Leveringsinfo</label>
                        <input type="text" class="drawer-field" data-field="delivery_notes" placeholder="Etage, port, kode...">
                    </div>
                </div>

                <!-- BESTIL BUD -->
                <div class="drawer-section drawer-delivery-section" data-drawer-section="bestil-bud">
                    <div class="drawer-label-row">
                        <label class="drawer-label">Bestil bud</label>
                        <div class="drawer-delivery-actions">
                            <button type="button" class="btn-drawer-logistik" data-action="see-logistik">📍 Se i logistik</button>
                            <button type="button" class="btn-drawer-lobo-quote" data-action="lobo-quote" title="Hent live pris hos By-expressen">💰 By-ex pris</button>
                            <button type="button" class="btn-drawer-bestil-bud" data-action="bestil">
                                <span class="drawer-bestil-icon">📦</span> <span class="drawer-bestil-label">Bestil hos…</span>
                            </button>
                            <button type="button" class="btn-drawer-cancel-bud" data-action="cancel" hidden>Annullér</button>
                        </div>
                    </div>
                    <div class="drawer-delivery-status">
                        <div class="drawer-lobo-quote" hidden></div>
                        <div class="drawer-delivery-current"></div>
                        <div class="drawer-delivery-suggestion"></div>
                        <div class="drawer-delivery-cost-row">
                            <div class="drawer-field-group" style="flex:1">
                                <label class="drawer-sublabel">Faktisk omkostning (kr)</label>
                                <input type="number" class="drawer-field drawer-delivery-cost-input"
                                       min="0" step="1" placeholder="Indtast når faktura modtages">
                            </div>
                            <div class="drawer-field-group" style="flex:0 0 auto; padding-top:18px">
                                <button type="button" class="btn-drawer-cost-save" disabled>Gem</button>
                            </div>
                        </div>
                        <div class="drawer-delivery-events"></div>
                    </div>
                </div>

                <!-- KUNDE -->
                <div class="drawer-section" data-drawer-section="kunde">
                    <label class="drawer-label">Kunde</label>
                    <div class="drawer-kunde-container"></div>
                    <label class="drawer-sublabel" style="margin-top:12px">Dagskontakt</label>
                    <div class="drawer-row">
                        <input type="text" class="drawer-field" data-field="day_contact_name" placeholder="Kontaktperson på dagen">
                        <input type="tel" class="drawer-field" data-field="day_contact_phone" placeholder="Telefon">
                    </div>
                </div>

                <!-- KØKKEN -->
                <div class="drawer-section">
                    <label class="drawer-label">Køkken</label>
                    <label class="drawer-check-row">
                        <input type="checkbox" class="drawer-field" data-field="kitchen_selects">
                        <span>Køkkenet vælger menu</span>
                    </label>
                    <div class="drawer-row">
                        <div class="drawer-field-group">
                            <label class="drawer-sublabel">Pax</label>
                            <input type="number" class="drawer-field" data-field="pax" min="0">
                        </div>
                        <div class="drawer-field-group">
                            <label class="drawer-sublabel">Enheder</label>
                            <input type="number" class="drawer-field" data-field="total_units" min="0">
                        </div>
                    </div>
                    <div class="drawer-row">
                        <div class="drawer-field-group">
                            <label class="drawer-sublabel">Priskategori</label>
                            <select class="drawer-field" data-field="price_category_id"></select>
                        </div>
                        <div class="drawer-field-group">
                            <label class="drawer-sublabel">Betaling</label>
                            <select class="drawer-field" data-field="payment_type"></select>
                        </div>
                    </div>
                </div>

                <!-- VARER -->
                <div class="drawer-section">
                    <div class="drawer-label-row">
                        <label class="drawer-label">Varer</label>
                        <button type="button" class="btn-drawer-tilfoej-vare">+ Tilføj vare</button>
                    </div>
                    <div class="drawer-vare-picker-slot"></div>
                    <div class="drawer-lines-list"></div>
                </div>

                <!-- FIRMA -->
                <div class="drawer-section drawer-firma-section" data-drawer-section="firma">
                    <label class="drawer-label">Firma</label>
                    <div class="drawer-firma-name"></div>
                    <div class="drawer-row">
                        <div class="drawer-field-group">
                            <label class="drawer-sublabel">EAN</label>
                            <input type="text" class="drawer-field" data-field="ean" placeholder="EAN-nummer">
                        </div>
                    </div>
                </div>

                <!-- NOTER -->
                <div class="drawer-section">
                    <label class="drawer-label">Noter</label>
                    <label class="drawer-sublabel">Kundeønsker</label>
                    <textarea class="drawer-field drawer-textarea" data-field="customer_wishes" rows="2"></textarea>
                    <label class="drawer-sublabel">Faktura info</label>
                    <textarea class="drawer-field drawer-textarea" data-field="invoice_info" rows="2"></textarea>
                    <label class="drawer-sublabel">Køkken info</label>
                    <textarea class="drawer-field drawer-textarea" data-field="kitchen_info" rows="2"></textarea>
                    <label class="drawer-sublabel">Interne noter</label>
                    <textarea class="drawer-field drawer-textarea" data-field="internal_notes" rows="2"></textarea>
                </div>

                <!-- MAIL -->
                <div class="drawer-section drawer-mail-section">
                    <label class="drawer-label drawer-mail-toggle" onclick="this.closest('.drawer-mail-section').classList.toggle('open')">
                        ${mailIcon(15)} Mail <span class="drawer-mail-badge" id="drawerMailBadge"></span>
                        <span class="drawer-mail-arrow">▾</span>
                    </label>
                    <div class="drawer-mail-content">
                        <div id="drawerMailHistory" class="drawer-mail-history"></div>
                        <div class="drawer-mail-compose">
                            <div class="drawer-mail-compose-toggle" onclick="this.nextElementSibling.classList.toggle('open'); this.classList.toggle('open')">
                                + Skriv mail
                            </div>
                            <div class="drawer-mail-compose-form">
                                <div class="bm-field">
                                    <label>Til</label>
                                    <input type="email" id="drawerMailTo" class="drawer-field" placeholder="email@example.com">
                                </div>
                                <div class="bm-field">
                                    <label>Skabelon</label>
                                    <select id="drawerMailTemplate" class="drawer-field" onchange="_drawerApplyTemplate()">
                                        <option value="">— Ingen skabelon —</option>
                                    </select>
                                </div>
                                <div class="bm-field">
                                    <label>Emne</label>
                                    <input type="text" id="drawerMailSubject" class="drawer-field" placeholder="Emne…">
                                </div>
                                <div class="bm-field">
                                    <label>Besked</label>
                                    <textarea id="drawerMailBody" class="drawer-field drawer-textarea" rows="6" placeholder="Skriv besked…"></textarea>
                                </div>
                                <input type="file" id="drawerMailFile" accept=".pdf,.jpg,.jpeg,.png,.gif,.xlsx,.docx" style="display:none" onchange="_drawerOnFileSelected(this)">
                                <div id="drawerMailAttachments" class="bm-attachments"></div>
                                <div class="bm-compose-actions">
                                    <button type="button" class="bm-attach" onclick="_drawerAttachFile()">📎 Vedhæft</button>
                                    <button type="button" class="bm-send" id="drawerMailSendBtn" onclick="_drawerSendMail()">${mailIcon(13)} Send</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="drawer-footer">
                <button type="button" class="btn-drawer-slet">Slet bon</button>
                <button type="button" class="btn-drawer-gem" disabled>Gem</button>
            </div>
        `;

        document.body.appendChild(this.overlayEl);
        document.body.appendChild(this.el);

        // VarePicker
        this.varePicker = new VarePicker({
            bonId: null,
            priceCategory: 'catering',
            container: this.el.querySelector('.drawer-vare-picker-slot'),
            viewName: 'drawer',
            onAdded: () => this._reloadLines()
        });

        // KundeSoeg
        this.kundeSoeg = new KundeSoeg({
            container: this.el.querySelector('.drawer-kunde-container'),
            onSelect: (data) => {
                if (!data) {
                    this._updateField('customer_id', null);
                    this._updateField('company_id', null);
                    return;
                }
                this._updateField('customer_id', data.customer_id);
                this._updateField('company_id', data.company_id);
                this._renderFirma(data.company_name);
            }
        });

        // Event listeners
        this._bindEvents();
    }

    _bindEvents() {
        // Close
        this.el.querySelector('.drawer-close').addEventListener('click', () => this.hide());

        // Note-sublabels: klik på label expander/kollapser textarea-størrelsen
        this.el.querySelectorAll('.drawer-sublabel').forEach((label) => {
            const ta = label.nextElementSibling;
            if (!ta || !ta.classList.contains('drawer-textarea')) return;
            label.classList.add('drawer-sublabel-toggleable');
            label.addEventListener('click', () => {
                const expanded = label.classList.toggle('is-expanded');
                if (expanded) {
                    ta.style.height = 'auto';
                    ta.style.height = ta.scrollHeight + 'px';
                    const onInput = () => {
                        ta.style.height = 'auto';
                        ta.style.height = ta.scrollHeight + 'px';
                    };
                    ta._autoGrowHandler = onInput;
                    ta.addEventListener('input', onInput);
                } else {
                    ta.style.height = '';
                    if (ta._autoGrowHandler) {
                        ta.removeEventListener('input', ta._autoGrowHandler);
                        ta._autoGrowHandler = null;
                    }
                }
            });
        });

        this.el.querySelector('.drawer-history').addEventListener('click', () => {
            if (!this.bonId) return;
            const bonNumber = this.el.querySelector('.drawer-title').textContent.replace(/^Bon #|\s*🔧$/g, '').trim();
            if (typeof window.showHistorik === 'function') {
                window.showHistorik({ bonId: this.bonId, bonNumber });
            }
        });

        this.el.querySelector('.drawer-flyver').addEventListener('click', () => {
            if (!this.bonId) return;
            const bonNumber = this.el.querySelector('.drawer-title').textContent.replace(/^Bon #|\s*🔧$/g, '').trim();
            if (typeof window.openFlyverComposer === 'function') {
                window.openFlyverComposer(this.bonId, bonNumber);
            } else {
                console.warn('Flyver-systemet er ikke indlæst på denne side.');
            }
        });

        this.el.querySelector('.drawer-copy').addEventListener('click', async () => {
            if (!this.bonId) return;
            if (this.dirty && !confirm('Du har ugemte ændringer. Kopiér alligevel — uden at gemme dem først?')) return;
            if (!confirm('Kopiér denne bon? Den nye bon får status NY og dagens dato som ordredato.')) return;
            const btn = this.el.querySelector('.drawer-copy');
            const oldHtml = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = 'Kopierer…';
            try {
                const newBon = await copyBon(this.bonId);
                this.open(newBon.id);
            } catch (e) {
                alert('Kunne ikke kopiere bon: ' + (e.message || e));
            } finally {
                btn.disabled = false;
                btn.innerHTML = oldHtml;
            }
        });
        this.overlayEl.addEventListener('click', () => this.hide());

        // Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.el.classList.contains('open')) this.hide();
        });

        // Dirty tracking on all fields — undtagen mail-compose-felterne, som også
        // bærer .drawer-field men ikke er bon-felter (det at skrive en mail må ikke
        // markere bonen som ugemt eller tænde Gem-knappen).
        this.el.querySelectorAll('.drawer-field').forEach(field => {
            if (field.closest('.drawer-mail-section')) return;
            const event = field.tagName === 'SELECT' || field.type === 'checkbox' ? 'change' : 'input';
            field.addEventListener(event, () => this._markDirty());
        });

        // Type toggle
        this.el.querySelectorAll('.drawer-type').forEach(btn => {
            btn.addEventListener('click', () => {
                this.el.querySelectorAll('.drawer-type').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this._toggleDeliveryFields(btn.dataset.type);
                this._markDirty();
            });
        });

        // Gem
        this.el.querySelector('.btn-drawer-gem').addEventListener('click', () => this._save());

        // Slet
        this.el.querySelector('.btn-drawer-slet').addEventListener('click', () => this._handleDelete());

        // Tilføj vare
        this.el.querySelector('.btn-drawer-tilfoej-vare').addEventListener('click', () => this.varePicker.toggle());

        // DAWA autocomplete
        this._bindDAWA();

        // Status bar clicks
        this.el.querySelector('.drawer-status-bar').addEventListener('click', (e) => {
            const btn = e.target.closest('.sbar-btn');
            if (!btn) return;
            this._setStatus(btn.dataset.target);
        });
    }

    /* ══════════════════════════════════════════════════════
       LOAD & RENDER
       ══════════════════════════════════════════════════════ */

    async load(bonId, opts) {
        this.bonId = bonId;
        this.dirty = false;
        this._pendingChanges = {};
        // _render() populerer felterne — bl.a. KundeSoeg.select() der fyrer onSelect →
        // _updateField → _markDirty. _loading-vagten gør _markDirty til en no-op imens,
        // så draweren ikke fejlagtigt markeres som ændret ved hver åbning.
        this._loading = true;
        try {
            this.data = await fetchBon(bonId);
            this._render();
            if (this.flagStrip) {
                this.flagStrip.setBonId(bonId);
                this.flagStrip.setFlags(this.data.flags || []);
                if (opts && opts.expandFlags) this.flagStrip.forceExpand();
            }
        } catch (err) {
            console.error('Kunne ikke hente bon:', err);
        } finally {
            this._loading = false;
            // Render-tidens onSelect kan have fyldt _pendingChanges — nulstil så kun
            // ægte bruger-ændringer tæller.
            this._pendingChanges = {};
            this.dirty = false;
        }
    }

    _render() {
        const d = this.data;
        if (!d) return;

        // Header
        const isInternal = d.is_internal === 1 || d.is_internal === true;
        this.el.querySelector('.drawer-title').textContent = `Bon #${d.bon_number}${isInternal ? ' 🔧' : ''}`;
        this.el.querySelector('.drawer-header').classList.remove('has-changes');
        this.el.querySelector('.btn-drawer-gem').disabled = true;

        // Hide/show sections for internal production bons
        const levSection = this.el.querySelector('[data-drawer-section="levering"]');
        const kundeSection = this.el.querySelector('[data-drawer-section="kunde"]');
        const firmaSection = this.el.querySelector('[data-drawer-section="firma"]');
        if (levSection) {
            if (isInternal) {
                // Show only date, hide type/address/method
                levSection.querySelector('.drawer-label').textContent = 'Produktionsdato';
                levSection.querySelector('.drawer-type-toggle').style.display = 'none';
                levSection.querySelector('.drawer-delivery-fields').style.display = 'none';
                const pickupRow = levSection.querySelector('[data-field="pickup_time"]')?.closest('.drawer-row');
                if (pickupRow) pickupRow.style.display = 'none';
            } else {
                levSection.querySelector('.drawer-label').textContent = 'Levering';
                levSection.querySelector('.drawer-type-toggle').style.display = '';
                levSection.querySelector('.drawer-delivery-fields').style.display = '';
                const pickupRow = levSection.querySelector('[data-field="pickup_time"]')?.closest('.drawer-row');
                if (pickupRow) pickupRow.style.display = '';
            }
        }
        if (kundeSection) kundeSection.style.display = isInternal ? 'none' : '';
        if (firmaSection) firmaSection.style.display = isInternal ? 'none' : '';

        // Status bar
        this._renderStatusBar();

        // Levering
        this._setFieldValue('delivery_date', d.delivery_date || '');
        this._setFieldValue('delivery_time', d.delivery_time || '');
        this._setFieldValue('pickup_time', d.pickup_time || '');

        // Type
        const dtype = d.delivery_type || 'delivery';
        this.el.querySelectorAll('.drawer-type').forEach(b => {
            b.classList.toggle('active', b.dataset.type === dtype);
        });
        this._toggleDeliveryFields(dtype);

        // Delivery fields
        this._setFieldValue('delivery_notes', d.delivery_notes || '');

        // Address display
        if (d.delivery_address) {
            const addr = d.delivery_address;
            const display = this.el.querySelector('.drawer-address-display');
            display.textContent = [addr.street_name, addr.street_nr, addr.postal_code, addr.city].filter(Boolean).join(' ');
            display.style.display = 'block';
            this.el.querySelector('.drawer-dawa-input').style.display = 'none';
            // Allow clearing
            display.innerHTML += ' <button class="drawer-addr-clear" type="button">&times;</button>';
            display.querySelector('.drawer-addr-clear').addEventListener('click', () => {
                this._updateField('delivery_address_id', null);
                display.style.display = 'none';
                this.el.querySelector('.drawer-dawa-input').style.display = '';
                this.el.querySelector('.drawer-dawa-input').value = '';
                this._markDirty();
            });
        } else {
            this.el.querySelector('.drawer-address-display').style.display = 'none';
            this.el.querySelector('.drawer-dawa-input').style.display = '';
            this.el.querySelector('.drawer-dawa-input').value = '';
        }

        // Kunde
        if (d.customer_id) {
            this.kundeSoeg.select({
                customer_id: d.customer_id,
                company_id: d.company_id,
                first_name: d.contact_name_full?.split(' ')[0] || '',
                last_name: d.contact_name_full?.split(' ').slice(1).join(' ') || '',
                company_name: d.company_name || null,
                phone: d.customer_phone || '',
                email: d.customer_email || '',
                default_payment_type: d.payment_type,
                default_price_category_id: d.price_category_id,
            });
        } else {
            this.kundeSoeg.clear();
        }

        // Dagskontakt — pre-fill fra kunde hvis tom
        this._setFieldValue('day_contact_name', d.day_contact_name || d.contact_name_full || '');
        this._setFieldValue('day_contact_phone', d.day_contact_phone || d.contact_phone || '');

        // Køkken
        this._setCheckbox('kitchen_selects', d.kitchen_selects);
        this._setFieldValue('pax', d.pax || '');
        this._setFieldValue('total_units', d.total_units || '');
        this._setFieldValue('price_category_id', d.price_category_id || '');
        this._setFieldValue('payment_type', d.payment_type || '');

        // Firma
        this._renderFirma(d.company_name);

        // Varer — update picker + render lines
        this.varePicker.update({
            bonId: this.bonId,
            priceCategory: d.price_category_code || 'catering'
        });
        this._renderLines(d.lines || []);

        // Noter
        this._setFieldValue('customer_wishes', d.customer_wishes || '');
        this._setFieldValue('invoice_info', d.invoice_info || '');
        this._setFieldValue('kitchen_info', d.kitchen_info || '');
        this._setFieldValue('internal_notes', d.internal_notes || '');

        // Mail — load async (non-blocking)
        this._loadMail(d);

        // Delivery — load async (non-blocking)
        this._loadDelivery(d);

        this.dirty = false;
        this._pendingChanges = {};
    }

    async _loadDelivery(bon) {
        const section = this.el.querySelector('[data-drawer-section="bestil-bud"]');
        if (!section) return;

        // Hide for internal bons + pickup
        if (bon.is_internal === 1 || bon.delivery_type === 'pickup') {
            section.style.display = 'none';
            return;
        }
        section.style.display = '';

        const currentEl = section.querySelector('.drawer-delivery-current');
        const eventsEl = section.querySelector('.drawer-delivery-events');
        const costInput = section.querySelector('.drawer-delivery-cost-input');
        const costSaveBtn = section.querySelector('.btn-drawer-cost-save');
        const bestilBtn = section.querySelector('.btn-drawer-bestil-bud');

        // Pre-fill faktisk omkostning
        costInput.value = bon.delivery_cost != null ? bon.delivery_cost : '';
        costSaveBtn.disabled = true;
        costInput.oninput = () => {
            const numVal = costInput.value.trim();
            costSaveBtn.disabled = !numVal || isNaN(Number(numVal)) || Number(numVal) < 0;
        };
        costSaveBtn.onclick = async () => {
            const amount = Number(costInput.value);
            if (isNaN(amount) || amount < 0) return;
            costSaveBtn.disabled = true;
            costSaveBtn.textContent = 'Gemmer…';
            try {
                await setDeliveryActualCost({ bon_id: this.bonId, amount_dkk: amount, source: 'manual' });
                costSaveBtn.textContent = 'Gemt ✓';
                setTimeout(() => { costSaveBtn.textContent = 'Gem'; }, 1500);
                // Refresh events list
                this._renderDeliveryEvents();
            } catch (err) {
                alert('Kunne ikke gemme: ' + (err.message || 'fejl'));
                costSaveBtn.disabled = false;
                costSaveBtn.textContent = 'Gem';
            }
        };

        bestilBtn.onclick = () => {
            // Drawer i hovedvinduet opdaterer via SSE når popout-vinduet
            // gemmer booking. Ingen onBooked-callback nødvendig.
            openDeliveryNote(this.bonId, bon.delivery_vehicle_id || null);
        };

        // "By-ex pris" — on-demand live kostpris hos By-expressen. Opretter en
        // kortvarig orderdraft hos Lobo (slettes straks) — INGEN ordre, intet bud.
        // Kasse-antal kan justeres → ekstra kasser koster mere.
        const quoteBtn = section.querySelector('.btn-drawer-lobo-quote');
        const quoteEl = section.querySelector('.drawer-lobo-quote');
        if (quoteBtn && quoteEl) {
            const kr = (n) => n == null ? '–' : Number(n).toLocaleString('da-DK', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' kr';
            let quoteBoxes = null; // null = lad serveren bruge bonens kasse-antal
            const renderQuote = async (isUpdate) => {
                quoteBtn.disabled = true;
                quoteEl.hidden = false;
                if (isUpdate && quoteEl.classList.contains('ok')) {
                    // Behold kortet — dæmp kun + opdatér kasse-tallet straks (intet blink)
                    quoteEl.classList.add('busy');
                    const nEl = quoteEl.querySelector('.lq-box-n');
                    if (nEl && quoteBoxes != null) nEl.textContent = quoteBoxes;
                } else {
                    quoteEl.className = 'drawer-lobo-quote loading';
                    quoteEl.textContent = 'Henter By-ex pris…';
                }
                try {
                    const q = await fetchLoboQuote(this.bonId, quoteBoxes);
                    quoteBoxes = q.boxes;  // synk til det serveren regnede med
                    const dist = q.routedistance != null ? (q.routedistance / 1000).toLocaleString('da-DK', { maximumFractionDigits: 1 }) + ' km' : '';
                    const marginCls = q.margin == null ? '' : (q.margin < 0 ? 'neg' : 'pos');
                    const marginTxt = q.margin == null ? '' :
                        `<span class="lq-margin ${marginCls}">margin ${q.margin >= 0 ? '+' : ''}${kr(q.margin)}</span>`;
                    const incl = q.included_boxes != null ? ` <span class="lq-dim">(${q.included_boxes} inkl.)</span>` : '';
                    quoteEl.className = 'drawer-lobo-quote ok';
                    quoteEl.innerHTML =
                        `<div class="lq-head">🚴 By-ex pris</div>` +
                        `<div class="lq-row lq-boxes"><span>Kasser${incl}</span>` +
                          `<span class="lq-stepper"><button type="button" class="lq-box-btn" data-box="-1">−</button>` +
                          `<strong class="lq-box-n">${q.boxes}</strong>` +
                          `<button type="button" class="lq-box-btn" data-box="1">+</button></span></div>` +
                        `<div class="lq-row"><span>Kostpris</span><strong>${kr(q.cost_ex)} <span class="lq-dim">ex moms</span></strong></div>` +
                        (q.cost_incl != null ? `<div class="lq-row lq-dim"><span></span><span>${kr(q.cost_incl)} incl</span></div>` : '') +
                        (q.customer_ex != null ? `<div class="lq-row"><span>Kundepris (std)</span><span>${kr(q.customer_ex)} ex</span></div>` : '') +
                        (marginTxt ? `<div class="lq-row">${marginTxt}${dist ? `<span class="lq-dim">${dist}</span>` : ''}</div>` :
                            (dist ? `<div class="lq-row lq-dim"><span>${dist}</span></div>` : '')) +
                        (q.margin != null && q.margin < 0 ? `<div class="lq-warn">⚠ Lobo-prisen overstiger kundeprisen — I taber på leveringen.</div>` : '');
                } catch (err) {
                    quoteEl.className = 'drawer-lobo-quote err';
                    if (err.code === 'config') {
                        quoteEl.textContent = 'By-ex er ikke konfigureret endnu (mangler API-opsætning).';
                    } else if (err.code === 'address_not_found') {
                        quoteEl.textContent = err.message || 'Adressen kunne ikke verificeres hos By-expressen.';
                    } else {
                        quoteEl.textContent = 'Kunne ikke hente pris: ' + (err.message || 'fejl');
                    }
                } finally {
                    quoteBtn.disabled = false;
                }
            };
            quoteBtn.onclick = () => { quoteBoxes = null; renderQuote(false); };
            // Kasse-stepper (delegeret — knapperne gen-renderes ved hver quote)
            quoteEl.onclick = (e) => {
                const b = e.target.closest('.lq-box-btn');
                if (!b || quoteEl.classList.contains('busy')) return;
                const delta = parseInt(b.getAttribute('data-box'), 10);
                quoteBoxes = Math.max(0, (Number(quoteBoxes) || 0) + delta);
                renderQuote(true);
            };
        }

        // "Se i logistik" — åbn logistik-viewet fokuseret på denne bon.
        const seeLogistikBtn = section.querySelector('.btn-drawer-logistik');
        if (seeLogistikBtn) {
            seeLogistikBtn.onclick = () => {
                const d = bon.delivery_date || '';
                if (typeof window.openLogistikForBon === 'function') {
                    window.openLogistikForBon(this.bonId, d);
                } else {
                    window.location.href = '/kitchen/logistik.html?bon=' + this.bonId
                        + (d ? '&date=' + encodeURIComponent(d) : '');
                }
            };
        }

        // Skift/annullér-affordance: når der allerede er en booking
        // hedder knappen "Skift bud", og en annullér-knap dukker op.
        const hasBooking = !!bon.delivery_vehicle_id;
        const cancelBtn = section.querySelector('.btn-drawer-cancel-bud');
        const labelSpan = bestilBtn.querySelector('.drawer-bestil-label');
        const iconSpan = bestilBtn.querySelector('.drawer-bestil-icon');

        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Annullér';
        if (hasBooking) {
            if (labelSpan) labelSpan.textContent = 'Skift bud';
            if (iconSpan) iconSpan.textContent = '🔄';
            cancelBtn.hidden = false;
        } else {
            if (labelSpan) labelSpan.textContent = 'Bestil hos…';
            if (iconSpan) iconSpan.textContent = '📦';
            cancelBtn.hidden = true;
        }

        cancelBtn.onclick = async () => {
            if (!confirm('Annullér bookingen?\nBonen sættes tilbage til "ikke planlagt". En eventuel faktisk omkostning bevares.')) return;
            cancelBtn.disabled = true;
            cancelBtn.textContent = 'Annullerer…';
            try {
                await cancelDelivery({ bon_id: this.bonId });
                await this.load(this.bonId);
            } catch (err) {
                alert('Kunne ikke annullere: ' + (err.message || 'fejl'));
                cancelBtn.disabled = false;
                cancelBtn.textContent = 'Annullér';
            }
        };

        // Render aktuel vehicle-status + forslag + events
        this._renderDeliveryCurrent(bon);
        this._renderDeliverySuggestion();
        this._renderDeliveryEvents();
    }

    _renderDeliveryCurrent(bon) {
        const el = this.el.querySelector('.drawer-delivery-current');
        if (!el) return;

        const parts = [];
        if (bon.courier_provider) {
            parts.push('<strong>' + esc(bon.courier_provider) + '</strong>');
        }
        if (bon.delivery_cost != null) {
            const sourceLabel = bon.delivery_cost_source === 'api' ? '(API)'
                : bon.delivery_cost_source === 'manual' ? '(manuelt)' : '';
            parts.push(bon.delivery_cost + ' kr ' + sourceLabel);
        } else if (bon.delivery_cost_estimated != null) {
            parts.push('estimat ca. ' + bon.delivery_cost_estimated + ' kr');
        }

        el.innerHTML = parts.length
            ? '<div class="drawer-delivery-current-pill">' + parts.join(' · ') + '</div>'
            : '<div class="drawer-delivery-empty">Ingen booking endnu</div>';
    }

    // Leverings-forslag (Spor 2): afstand fra HQ + vogn-anbefaling.
    // Read-only beslutningsgrundlag — selve bookingen sker via "Bestil hos…".
    async _renderDeliverySuggestion() {
        const el = this.el.querySelector('.drawer-delivery-suggestion');
        if (!el) return;
        const bonId = this.bonId;
        el.innerHTML = '<div class="drawer-delivery-loading">Beregner leveringsforslag…</div>';

        let r;
        try {
            r = await calculateDelivery({ bon_id: bonId });
        } catch (err) {
            if (this.bonId === bonId) el.innerHTML = '';
            return;
        }
        if (this.bonId !== bonId) return;   // draweren skiftede bon imens

        if (!r || !r.ok) {
            const reason = r && r.reason;
            let msg = '';
            if (reason === 'missing_coords') {
                msg = '📍 Leveringsadressen mangler koordinater — forslag kan ikke beregnes';
            } else if (reason === 'no_route') {
                msg = '📍 Rute kunne ikke beregnes for adressen';
            } else if (reason === 'no_api_key' || reason === 'hq_not_configured') {
                msg = '';   // routing ikke konfigureret — vis intet
            } else {
                msg = 'Leveringsafstand kunne ikke beregnes';
            }
            el.innerHTML = msg ? '<div class="drawer-sug-note">' + msg + '</div>' : '';
            return;
        }

        const icon = (t) => {
            if (t === 'own-bike') t = 'bike';
            const di = window.DeliveryIcons && (window.DeliveryIcons.get(t) || window.DeliveryIcons.defaults[t]);
            if (di) return di.icon;
            return '📦';
        };

        let head = '📍 ' + String(r.distance_km).replace('.', ',') + ' km · '
            + r.duration_min + ' min fra HQ';
        if (r.estimated_pickup_time) head += ' · afgang ca. ' + esc(r.estimated_pickup_time);

        const alts = (r.alternatives || []).slice()
            .sort((a, b) => {
                if (a.suitable !== b.suitable) return a.suitable ? -1 : 1;
                return (a.cost_dkk == null ? Infinity : a.cost_dkk)
                     - (b.cost_dkk == null ? Infinity : b.cost_dkk);
            })
            .map(a => {
                const isSug = a.vehicle_id === r.suggested_vehicle_id;
                const cost = a.cost_dkk != null ? ('ca. ' + a.cost_dkk + ' kr') : '–';
                // Constraint-brud er en ANBEFALING, ikke en spærring — vognen
                // kan stadig vælges (kunder betaler gerne for cykellevering langt ude).
                const caveat = (!a.suitable && a.reason)
                    ? '<span class="drawer-sug-caveat">⚠ ' + esc(a.reason)
                      + ' — kan vælges alligevel</span>'
                    : '';
                return '<div class="drawer-sug-alt' + (isSug ? ' drawer-sug-alt-best' : '') + '">'
                    + '<span class="drawer-sug-veh">' + icon(a.type) + ' ' + esc(a.label)
                    + (isSug ? ' <span class="drawer-sug-badge">forslag</span>' : '') + '</span>'
                    + '<span class="drawer-sug-cost">' + cost + '</span>'
                    + caveat
                    + '</div>';
            }).join('');

        el.innerHTML = '<div class="drawer-sug-head">' + head + '</div>'
            + '<div class="drawer-sug-list">' + alts + '</div>';
    }

    async _renderDeliveryEvents() {
        const el = this.el.querySelector('.drawer-delivery-events');
        if (!el) return;
        el.innerHTML = '<div class="drawer-delivery-loading">Henter…</div>';
        try {
            const events = await fetchDeliveryEvents(this.bonId);
            const bookings = events.filter(e => ['booked', 'failed', 'cancelled'].includes(e.event_type));
            if (!bookings.length) {
                el.innerHTML = '';
                return;
            }
            el.innerHTML = '<div class="drawer-delivery-events-label">Booking-historik</div>'
                + bookings.map(e => {
                    const date = _fmtMailDate(e.event_time);
                    const ref = e.external_reference ? ' · ref ' + esc(e.external_reference) : '';
                    const note = e.notes ? '<div class="drawer-delivery-event-note">' + esc(e.notes) + '</div>' : '';
                    const stateCls = e.event_type === 'failed' ? ' drawer-delivery-event-failed'
                        : e.event_type === 'cancelled' ? ' drawer-delivery-event-cancelled' : '';
                    const tag = e.event_type === 'failed'
                        ? '<span class="drawer-delivery-event-tag">Fejlede</span>'
                        : e.event_type === 'cancelled'
                        ? '<span class="drawer-delivery-event-tag">Annulleret</span>' : '';
                    return '<div class="drawer-delivery-event' + stateCls + '">'
                        + '<div class="drawer-delivery-event-head">'
                        + '<span class="drawer-delivery-event-vehicle">' + tag + esc(e.vehicle_label || e.provider || '?') + '</span>'
                        + '<span class="drawer-delivery-event-date">' + date + ref + '</span>'
                        + '</div>' + note
                        + '</div>';
                }).join('');
        } catch (err) {
            el.innerHTML = '<div class="drawer-delivery-error">Kunne ikke hente historik</div>';
        }
    }

    async _reloadBon() {
        if (!this.bonId) return;
        try {
            const data = await fetchBon(this.bonId);
            this.data = data;
            this._render();
        } catch (err) {
            console.error('Kunne ikke genindlæse bon:', err);
        }
    }

    async _loadMail(bon) {
        const histEl = this.el.querySelector('#drawerMailHistory');
        const badgeEl = this.el.querySelector('#drawerMailBadge');
        const toEl = this.el.querySelector('#drawerMailTo');
        const tmplSel = this.el.querySelector('#drawerMailTemplate');

        if (!histEl) return;
        histEl.innerHTML = '<div style="color:var(--color-text-dim);font-size:12px;padding:4px">Henter…</div>';

        try {
            const [mailData, templates] = await Promise.all([
                fetchBonMail(this.bonId),
                _mailTemplates || fetchMailTemplates().then(t => { _mailTemplates = t; return t; })
            ]);

            // Store vars + templates on drawer for send
            this._mailVars = typeof _buildMailVars === 'function' ? _buildMailVars(bon) : {};
            this._mailTemplates = templates;

            // Prefill to
            if (toEl) toEl.value = bon.contact_email || '';

            // Templates dropdown
            if (tmplSel) {
                tmplSel.innerHTML = '<option value="">— Ingen skabelon —</option>'
                    + (templates || []).map(t => '<option value="' + esc(t.key) + '">' + esc(t.label || t.key) + '</option>').join('');
            }

            // Render history via fælles MailThread-komponent
            const unread = MailThread.normalize({ threads: mailData.threads })
                .filter(m => m.direction === 'in' && !m.is_read).length;
            if (badgeEl) badgeEl.textContent = unread ? unread + ' ulæst' : '';

            MailThread.renderHistory(histEl, {
                threads: mailData.threads,
                emptyText: 'Ingen mails endnu',
                onMarkRead: (id) => markBonMailRead(this.bonId, id),
            });
        } catch (err) {
            histEl.innerHTML = '<div style="color:var(--color-red);font-size:12px;padding:4px">Fejl: ' + esc(err.message) + '</div>';
        }
    }

    _renderStatusBar() {
        const bar = this.el.querySelector('.drawer-status-bar');
        bar.innerHTML = '';
        if (!this.data) return;

        const curStatus = statusToFrontend(this.data.status_code || '');
        const allStatuses = Object.keys(BON_CONFIG.statuses);

        allStatuses.forEach(key => {
            const s = BON_CONFIG.statuses[key];
            const isActive = key === curStatus;
            const btn = document.createElement('button');
            btn.className = 'sbar-btn' + (isActive ? ' active' : '');
            btn.textContent = s.label;
            btn.dataset.target = key;
            if (isActive) {
                btn.style.background = s.color;
                btn.style.color = s.text;
            }
            bar.appendChild(btn);
        });
    }

    async _setStatus(statusKey) {
        if (!this.data) return;
        const curStatus = statusToFrontend(this.data.status_code || '');
        if (statusKey === curStatus) return;
        const backendCode = statusToBackend(statusKey);
        try {
            await patchBonStatus(this.bonId, backendCode);
            this.data.status_code = backendCode;
            this._renderStatusBar();
            this._showStatusFlash();
        } catch (err) {
            alert(err.message || 'Kunne ikke skifte status');
        }
    }

    _showStatusFlash() {
        const old = this.el.querySelector('.drawer-status-flash');
        if (old) old.remove();
        const flash = document.createElement('div');
        flash.className = 'drawer-status-flash';
        flash.textContent = '\u2713 Status gemt automatisk';
        const bar = this.el.querySelector('.drawer-status-bar');
        bar.parentElement.appendChild(flash);
        setTimeout(() => flash.remove(), 3500);
    }

    _renderFirma(companyName) {
        const section = this.el.querySelector('.drawer-firma-section');
        const nameEl = this.el.querySelector('.drawer-firma-name');
        if (companyName) {
            nameEl.textContent = companyName;
            section.style.display = '';
        } else {
            nameEl.textContent = '';
            section.style.display = 'none';
        }
    }

    /* ══════════════════════════════════════════════════════
       BON LINES
       ══════════════════════════════════════════════════════ */

    _renderLines(lines) {
        var list = this.el.querySelector('.drawer-lines-list');
        if (!list) return;
        if (!lines || lines.length === 0) {
            list.innerHTML = '<div class="drawer-lines-empty">Ingen varer tilføjet</div>';
            return;
        }
        var _esc = typeof esc === 'function' ? esc : function(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
        list.innerHTML = lines.map(function(l) {
            var special = l.special_request
                ? '<div class="drawer-line-special">' + _esc(l.special_request) + '</div>'
                : '';
            var price = l.line_total != null ? l.line_total + ' kr' : '';
            return '<div class="drawer-line-item" data-line-id="' + l.id + '" data-unit-price="' + (l.unit_price != null ? l.unit_price : '') + '">' +
                '<span class="drawer-line-qty qty-editable" title="Klik for at ændre antal">' + (l.quantity || 1) + '</span>' +
                '<span class="drawer-line-name name-editable" title="Klik for at tilføje eller ændre hjælpetekst">' + _esc(l.product_name || '') + special + '</span>' +
                '<span class="drawer-line-price">' + price + '</span>' +
                '<button class="drawer-line-del" title="Fjern">&times;</button>' +
            '</div>';
        }).join('');

        var self = this;

        // Delete line handlers
        list.querySelectorAll('.drawer-line-del').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var lineId = btn.closest('.drawer-line-item').dataset.lineId;
                self._deleteLine(lineId);
            });
        });

        // Qty edit handlers
        list.querySelectorAll('.drawer-line-qty.qty-editable').forEach(function(qtyEl) {
            qtyEl.addEventListener('click', function() { self._openQtyEdit(qtyEl); });
        });

        // Hjælpetekst (special_request) — klik på selve menulinjen (varenavnet) åbner editoren
        list.querySelectorAll('.drawer-line-name.name-editable').forEach(function(el) {
            el.addEventListener('click', function(e) {
                // Ignorér klik mens editoren er åben (input + gem/annuller-knapper)
                if (e.target.closest('.drawer-line-special-edit')) return;
                e.stopPropagation();
                self._openSpecialEdit(el.closest('.drawer-line-item'));
            });
        });
    }

    _openQtyEdit(qtyEl) {
        if (!qtyEl || qtyEl.classList.contains('editing')) return;
        var itemEl = qtyEl.closest('.drawer-line-item');
        if (!itemEl) return;
        var lineId = itemEl.dataset.lineId;
        var unitPrice = parseFloat(itemEl.dataset.unitPrice);
        var original = qtyEl.textContent.trim();
        var match = original.match(/^([\d.,]+)/);
        var num = match ? parseFloat(match[1].replace(',', '.')) : 1;

        qtyEl.dataset.originalQty = original;
        qtyEl.classList.add('editing');
        this._editingLineId = lineId;

        qtyEl.innerHTML =
            '<button type="button" class="qty-step qty-minus" tabindex="-1">−</button>' +
            '<input type="number" class="qty-input" min="1" step="1" value="' + num + '">' +
            '<button type="button" class="qty-step qty-plus" tabindex="-1">+</button>';

        var input = qtyEl.querySelector('.qty-input');
        var minus = qtyEl.querySelector('.qty-minus');
        var plus = qtyEl.querySelector('.qty-plus');
        var self = this;

        minus.addEventListener('click', function(e) {
            e.stopPropagation();
            input.value = Math.max(1, (parseInt(input.value) || 1) - 1);
            input.focus();
        });
        plus.addEventListener('click', function(e) {
            e.stopPropagation();
            input.value = (parseInt(input.value) || 1) + 1;
            input.focus();
        });
        input.addEventListener('click', function(e) { e.stopPropagation(); });
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); self._saveQtyEdit(qtyEl, lineId, unitPrice); }
            else if (e.key === 'Escape') { e.preventDefault(); self._cancelQtyEdit(qtyEl); }
        });
        input.addEventListener('blur', function() {
            setTimeout(function() {
                if (qtyEl.classList.contains('editing') && !qtyEl.contains(document.activeElement)) {
                    self._saveQtyEdit(qtyEl, lineId, unitPrice);
                }
            }, 120);
        });

        input.focus();
        input.select();
    }

    _saveQtyEdit(qtyEl, lineId, unitPrice) {
        var input = qtyEl.querySelector('.qty-input');
        if (!input) return;
        var newQty = parseInt(input.value);
        var original = qtyEl.dataset.originalQty || '';
        var originalNum = parseInt((original.match(/^([\d.,]+)/) || [])[1]) || 0;

        if (!Number.isFinite(newQty) || newQty < 1) {
            this._cancelQtyEdit(qtyEl);
            return;
        }
        if (newQty === originalNum) {
            this._cancelQtyEdit(qtyEl);
            return;
        }

        var itemEl = qtyEl.closest('.drawer-line-item');
        var priceEl = itemEl ? itemEl.querySelector('.drawer-line-price') : null;
        var self = this;
        qtyEl.classList.add('saving');
        putBonLine(this.bonId, lineId, { quantity: newQty })
            .then(function(updated) {
                qtyEl.textContent = String(newQty);
                qtyEl.classList.remove('editing', 'saving');
                delete qtyEl.dataset.originalQty;
                self._editingLineId = null;
                if (priceEl && updated && updated.line_total != null) {
                    priceEl.textContent = updated.line_total + ' kr';
                } else if (priceEl && Number.isFinite(unitPrice)) {
                    priceEl.textContent = (newQty * unitPrice) + ' kr';
                }
            })
            .catch(function(err) {
                console.error('Kunne ikke gemme antal:', err);
                qtyEl.classList.remove('saving');
                self._cancelQtyEdit(qtyEl);
                alert(err.message || 'Kunne ikke gemme antal');
            });
    }

    _cancelQtyEdit(qtyEl) {
        qtyEl.textContent = qtyEl.dataset.originalQty || qtyEl.textContent;
        qtyEl.classList.remove('editing', 'saving');
        delete qtyEl.dataset.originalQty;
        this._editingLineId = null;
    }

    _openSpecialEdit(itemEl) {
        if (!itemEl || itemEl.classList.contains('editing-special')) return;
        var nameEl = itemEl.querySelector('.drawer-line-name');
        if (!nameEl) return;
        var lineId = itemEl.dataset.lineId;
        var existing = itemEl.querySelector('.drawer-line-special');
        var current = existing ? existing.textContent.trim() : '';
        itemEl.classList.add('editing-special');

        // Fjern den eksisterende hjælpetekst-visning mens vi redigerer
        if (existing) existing.remove();

        var editor = document.createElement('div');
        editor.className = 'drawer-line-special-edit';
        editor.innerHTML =
            '<input type="text" class="special-input" placeholder="Hjælpetekst (fx glutenfri)" maxlength="200">' +
            '<button type="button" class="special-save" title="Gem">✓</button>' +
            '<button type="button" class="special-cancel" title="Annuller">&times;</button>';
        nameEl.appendChild(editor);

        var self  = this;
        var input = editor.querySelector('.special-input');
        input.value = current;

        editor.querySelector('.special-save').addEventListener('click', function(e) {
            e.stopPropagation();
            self._saveSpecialEdit(itemEl, lineId, input.value);
        });
        editor.querySelector('.special-cancel').addEventListener('click', function(e) {
            e.stopPropagation();
            self._reloadLines();
        });
        input.addEventListener('click', function(e) { e.stopPropagation(); });
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter')       { e.preventDefault(); self._saveSpecialEdit(itemEl, lineId, input.value); }
            else if (e.key === 'Escape') { e.preventDefault(); self._reloadLines(); }
        });

        input.focus();
        input.select();
    }

    _saveSpecialEdit(itemEl, lineId, rawValue) {
        var value = (rawValue || '').trim();
        var self  = this;
        itemEl.classList.add('saving-special');
        // Tom værdi → null rydder hjælpeteksten (linjen merger igen i køkkenet)
        putBonLine(this.bonId, lineId, { special_request: value || null })
            .then(function() {
                // Genindlæs så sortering/visning + køkkenets aggregering er konsistent
                self._reloadLines();
            })
            .catch(function(err) {
                console.error('Kunne ikke gemme hjælpetekst:', err);
                itemEl.classList.remove('saving-special');
                alert(err.message || 'Kunne ikke gemme hjælpetekst');
            });
    }

    /** Reload only lines list without re-rendering entire drawer (preserves picker state) */
    async _reloadLines() {
        if (!this.bonId) return;
        try {
            var bon = await fetchBon(this.bonId);
            this.data = bon;
            this._renderLines(bon.lines || []);
        } catch (err) {
            console.error('Kunne ikke genindlæse linjer:', err);
        }
    }

    async _deleteLine(lineId) {
        if (!confirm('Fjern denne vare?')) return;
        try {
            await deleteBonLine(this.bonId, lineId);
            await this.load(this.bonId);
        } catch (err) {
            alert(err.message || 'Kunne ikke fjerne vare');
        }
    }

    /* ══════════════════════════════════════════════════════
       FIELD HELPERS
       ══════════════════════════════════════════════════════ */

    _setFieldValue(fieldName, value) {
        const el = this.el.querySelector(`[data-field="${fieldName}"]`);
        if (!el) return;
        el.value = value;
    }

    _setCheckbox(fieldName, value) {
        const el = this.el.querySelector(`[data-field="${fieldName}"]`);
        if (!el) return;
        el.checked = !!value;
    }

    _getFieldValue(fieldName) {
        const el = this.el.querySelector(`[data-field="${fieldName}"]`);
        if (!el) return undefined;
        if (el.type === 'checkbox') return el.checked ? 1 : 0;
        if (el.type === 'number') return el.value ? parseInt(el.value) : 0;
        return el.value || null;
    }

    _updateField(fieldName, value) {
        if (!this._pendingChanges) this._pendingChanges = {};
        this._pendingChanges[fieldName] = value;
        // Kunde-, firma- og adresse-skift går gennem _updateField og skal også
        // tælle som ugemte ændringer — ellers lukker draweren uden at advare.
        this._markDirty();
    }

    _toggleDeliveryFields(type) {
        // Adresse + bestil bud er relevant ved både levering og event (et event
        // kan få et bud afhængig af hvor det holdes) — skjul kun ved afhentning.
        const deliveryFields = this.el.querySelector('.drawer-delivery-fields');
        deliveryFields.style.display = type === 'pickup' ? 'none' : '';

        const bestilSection = this.el.querySelector('[data-drawer-section="bestil-bud"]');
        if (bestilSection) {
            const isInternal = this.data?.is_internal === 1 || this.data?.is_internal === true;
            bestilSection.style.display = (type !== 'pickup' && !isInternal) ? '' : 'none';
        }
    }

    /* ══════════════════════════════════════════════════════
       DIRTY TRACKING
       ══════════════════════════════════════════════════════ */

    _markDirty() {
        if (this._loading) return;
        this.dirty = true;
        this.el.querySelector('.drawer-header').classList.add('has-changes');
        this.el.querySelector('.btn-drawer-gem').disabled = false;
    }

    /* ══════════════════════════════════════════════════════
       SAVE
       ══════════════════════════════════════════════════════ */

    async _save() {
        const payload = this._collectFields();
        if (Object.keys(payload).length === 0) return;

        const btn = this.el.querySelector('.btn-drawer-gem');
        btn.disabled = true;
        btn.textContent = 'Gemmer...';

        try {
            await patchBon(this.bonId, payload);
            this.dirty = false;
            this._pendingChanges = {};
            this.el.querySelector('.drawer-header').classList.remove('has-changes');
            // Reload data
            await this.load(this.bonId);
        } catch (err) {
            alert(err.message || 'Kunne ikke gemme');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Gem';
        }
    }

    _collectFields() {
        const fields = {};

        // Standard fields from data-field elements
        const fieldNames = [
            'delivery_date', 'delivery_time', 'pickup_time',
            'delivery_notes',
            'pax', 'total_units',
            'price_category_id', 'payment_type',
            'kitchen_selects',
            'day_contact_name', 'day_contact_phone',
            'customer_wishes', 'invoice_info', 'kitchen_info', 'internal_notes'
        ];

        for (const name of fieldNames) {
            const val = this._getFieldValue(name);
            if (val !== undefined) fields[name] = val;
        }

        // Delivery type from toggle
        const activeType = this.el.querySelector('.drawer-type.active');
        if (activeType) fields.delivery_type = activeType.dataset.type;

        // Pending changes (customer_id, company_id, delivery_address_id)
        if (this._pendingChanges) {
            Object.assign(fields, this._pendingChanges);
        }

        return fields;
    }

    /* ══════════════════════════════════════════════════════
       DELETE
       ══════════════════════════════════════════════════════ */

    async _handleDelete() {
        // To-trins: aktiv bon → aflys (soft). Allerede aflyst bon → slet permanent.
        const isAflyst = (this.data && this.data.status_code) === 'AFLYST';

        if (isAflyst) {
            if (!confirm('Bonen er aflyst. Vil du slette den PERMANENT?\n\nAlle linjer, historik og mails på bonen fjernes. Handlingen kan ikke fortrydes.')) return;
            try {
                await deleteBon(this.bonId);
                this.dirty = false;
                this._doHide();
            } catch (err) {
                alert(err.message || 'Kunne ikke slette bon');
            }
            return;
        }

        if (!confirm('Bonen aflyses (status AFLYST). Vil du fortsætte?\n\nTip: åbn den aflyste bon og tryk "Slet bon" igen for at slette den permanent.')) return;
        try {
            await patchBonStatus(this.bonId, 'AFLYST');
            // Bonen er aflyst — spørg ikke om at gemme eventuelle felt-ændringer.
            this.dirty = false;
            this._doHide();
        } catch (err) {
            alert(err.message || 'Kunne ikke slette/aflyse bon');
        }
    }

    /* ══════════════════════════════════════════════════════
       SHOW / HIDE
       ══════════════════════════════════════════════════════ */

    /** Convenience: load + show i ét kald */
    async open(bonId, opts) {
        await this.load(bonId, opts);
        this.show();
        if (opts && opts.justCreated) this._showCreatedBanner();
        if (opts && opts.scrollTo) {
            // Vent et frame så DOM er færdig-rendered før scroll
            requestAnimationFrame(() => {
                const target = this.el.querySelector(`[data-drawer-section="${opts.scrollTo}"]`);
                if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
        }
    }

    show() {
        this.el.classList.add('open');
        this.overlayEl.classList.add('open');
        document.body.style.overflow = 'hidden';
    }

    _showCreatedBanner() {
        // Remove any existing banner
        const old = this.el.querySelector('.drawer-created-banner');
        if (old) old.remove();

        const banner = document.createElement('div');
        banner.className = 'drawer-created-banner';
        banner.innerHTML = '✓ Bon oprettet — tilføj varer og detaljer, eller luk draweren';
        const body = this.el.querySelector('.drawer-body');
        if (body) body.insertBefore(banner, body.firstChild);

        // Auto-remove after 8s
        setTimeout(() => { if (banner.parentNode) banner.remove(); }, 8000);
    }

    hide() {
        if (this.dirty) {
            this._confirmClose();
            return;
        }
        this._doHide();
    }

    _doHide() {
        this.el.classList.remove('open');
        this.overlayEl.classList.remove('open');
        document.body.style.overflow = '';
        this.dirty = false;
    }

    /**
     * 3-vejs luk-dialog ved ugemte ændringer: Gem og luk / Luk uden at gemme / Bliv.
     * Erstatter den gamle 2-vejs confirm() der kun kunne kassere eller blive.
     */
    _confirmClose() {
        // Undgå dobbelt-dialog hvis hide() kaldes igen mens dialogen er åben.
        if (this._closeDialogEl) return;

        const overlay = document.createElement('div');
        overlay.className = 'drawer-confirm-overlay';
        overlay.innerHTML = `
            <div class="drawer-confirm" role="dialog" aria-modal="true">
                <div class="drawer-confirm-title">Ugemte ændringer</div>
                <div class="drawer-confirm-body">Du har ændringer der ikke er gemt. Hvad vil du gøre?</div>
                <div class="drawer-confirm-actions">
                    <button type="button" class="drawer-confirm-stay">Bliv</button>
                    <button type="button" class="drawer-confirm-discard">Luk uden at gemme</button>
                    <button type="button" class="drawer-confirm-save">Gem og luk</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        this._closeDialogEl = overlay;

        const cleanup = () => {
            overlay.remove();
            this._closeDialogEl = null;
            document.removeEventListener('keydown', onKey, true);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); cleanup(); }
        };
        document.addEventListener('keydown', onKey, true);

        overlay.querySelector('.drawer-confirm-stay').addEventListener('click', cleanup);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });

        overlay.querySelector('.drawer-confirm-discard').addEventListener('click', () => {
            cleanup();
            this._doHide();
        });

        overlay.querySelector('.drawer-confirm-save').addEventListener('click', async () => {
            const saveBtn = overlay.querySelector('.drawer-confirm-save');
            saveBtn.disabled = true;
            saveBtn.textContent = 'Gemmer…';
            await this._save();   // _save() håndterer selv fejl (alert) og rydder dirty ved succes
            if (this.dirty) {
                // Gem fejlede — _save() viser selv en alert; lad dialogen blive åben.
                saveBtn.disabled = false;
                saveBtn.textContent = 'Gem og luk';
                return;
            }
            cleanup();
            this._doHide();
        });
    }

    get isOpen() {
        return this.el.classList.contains('open');
    }

    /* ══════════════════════════════════════════════════════
       SSE
       ══════════════════════════════════════════════════════ */

    _bindSSE() {
        // Patch F: bon_updated + bon_status bruger nu konsistent {id} på payload
        window.addEventListener('sse:bon_updated', (e) => {
            const data = e.detail || {};
            if (data.id == this.bonId && !this.dirty && !this._editingLineId) {
                this.load(this.bonId);
            }
        });
        window.addEventListener('sse:bon_status', (e) => {
            const data = e.detail || {};
            if (data.id == this.bonId && !this.dirty && !this._editingLineId) {
                this.load(this.bonId);
            }
        });
    }

    /* ══════════════════════════════════════════════════════
       DAWA AUTOCOMPLETE
       ══════════════════════════════════════════════════════ */

    _bindDAWA() {
        const input = this.el.querySelector('.drawer-dawa-input');
        const results = this.el.querySelector('.drawer-dawa-results');
        let timer = null;

        input.addEventListener('input', () => {
            clearTimeout(timer);
            const q = input.value.trim();
            if (q.length < 3) {
                results.innerHTML = '';
                results.style.display = 'none';
                return;
            }
            timer = setTimeout(async () => {
                try {
                    const resp = await fetch(`https://api.dataforsyningen.dk/adresser/autocomplete?q=${encodeURIComponent(q)}&per_side=5`);
                    const data = await resp.json();
                    results.innerHTML = '';
                    if (data.length === 0) {
                        results.style.display = 'none';
                        return;
                    }
                    results.style.display = 'block';
                    for (const item of data) {
                        const div = document.createElement('div');
                        div.className = 'drawer-dawa-item';
                        div.textContent = item.tekst;
                        div.addEventListener('click', () => this._selectDAWA(item));
                        results.appendChild(div);
                    }
                } catch (err) {
                    console.error('DAWA fejl:', err);
                }
            }, 300);
        });

        // Close results on outside click
        document.addEventListener('click', (e) => {
            if (!input.contains(e.target) && !results.contains(e.target)) {
                results.style.display = 'none';
            }
        });
    }

    async _selectDAWA(item) {
        const results = this.el.querySelector('.drawer-dawa-results');
        results.style.display = 'none';

        try {
            // DAWA's autocomplete-item bærer ALLEREDE de flade felter på .adresse
            // (vejnavn/husnr/postnr/postnrnavn + x=lon/y=lat i WGS84). Den gamle
            // kode lavede et 2. fetch mod /adresser/{id} og læste vejnavn/husnr/postnr
            // dér — men på den fulde ressource ligger de NESTED under adgangsadresse,
            // så de blev undefined og adressen blev gemt som kun det første ord
            // ("Arne"). Brug item.adresse direkte; fald kun tilbage til den fulde
            // ressource (nested) hvis item.adresse mangler vejnavn.
            let a = item.adresse || {};
            if (!a.vejnavn) {
                const href = a.href || (a.id && `https://api.dataforsyningen.dk/adresser/${a.id}`);
                if (href) {
                    const full = await (await fetch(href)).json();
                    const ag = full.adgangsadresse || {};
                    const koord = ag.adgangspunkt && ag.adgangspunkt.koordinater;
                    a = {
                        vejnavn: (ag.vejstykke && ag.vejstykke.navn) || '',
                        husnr: ag.husnr || '',
                        postnr: (ag.postnummer && ag.postnummer.nr) || '',
                        postnrnavn: (ag.postnummer && ag.postnummer.navn) || '',
                        x: koord && koord[0], y: koord && koord[1],
                    };
                }
            }

            const addressData = {
                street_name: a.vejnavn || '',
                street_nr: a.husnr || '',
                postal_code: a.postnr || '',
                city: a.postnrnavn || '',
                lat: a.y != null ? Number(a.y) : null,
                lon: a.x != null ? Number(a.x) : null,
            };
            if (!addressData.street_name) { console.error('DAWA: kunne ikke udlede vejnavn', item); return; }

            // Gem adresse
            const result = await createAddress(addressData);
            this._updateField('delivery_address_id', result.id);

            // Vis
            const display = this.el.querySelector('.drawer-address-display');
            display.textContent = item.tekst;
            display.style.display = 'block';
            display.innerHTML += ' <button class="drawer-addr-clear" type="button">&times;</button>';
            display.querySelector('.drawer-addr-clear').addEventListener('click', () => {
                this._updateField('delivery_address_id', null);
                display.style.display = 'none';
                this.el.querySelector('.drawer-dawa-input').style.display = '';
                this.el.querySelector('.drawer-dawa-input').value = '';
                this._markDirty();
            });

            this.el.querySelector('.drawer-dawa-input').style.display = 'none';
            this._markDirty();
        } catch (err) {
            console.error('Adresse-fejl:', err);
        }
    }

    /* ══════════════════════════════════════════════════════
       DROPDOWNS
       ══════════════════════════════════════════════════════ */

    async _loadDropdowns() {
        try {
            const [cats, types] = await Promise.all([
                fetchPriceCategories(),
                fetchPaymentTypes()
            ]);
            this.priceCategories = cats;
            this.paymentTypes = types;

            const pcSel = this.el.querySelector('[data-field="price_category_id"]');
            pcSel.innerHTML = '<option value="">Vælg...</option>';
            for (const pc of cats) {
                pcSel.innerHTML += `<option value="${pc.id}">${esc(pc.label)}</option>`;
            }

            const ptSel = this.el.querySelector('[data-field="payment_type"]');
            ptSel.innerHTML = '<option value="">Vælg...</option>';
            for (const pt of types) {
                ptSel.innerHTML += `<option value="${pt.code}">${esc(pt.label)}</option>`;
            }
        } catch (err) {
            console.error('Kunne ikke hente dropdown-data:', err);
        }
    }
}

/* ── Drawer Mail helpers (global — called from onclick i DOM) ── */

var _drawerInstance = null; // Set by the page that creates BonDrawer
if (typeof _mailTemplates === 'undefined') var _mailTemplates = null; // Shared cache — may also be defined in bon_kort.js
if (typeof _fmtMailDate === 'undefined') {
    var _fmtMailDate = function(isoStr) {
        if (!isoStr) return '';
        var d = parseServerDate(isoStr);
        if (!d || isNaN(d.getTime())) return '';
        return d.getDate() + '/' + (d.getMonth()+1) + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    };
}
if (typeof _buildMailVars === 'undefined') {
    var _buildMailVars = function(bon) {
        var lines = bon.lines || [];
        var groups = bon.menu_groups || [];
        var menuLines = lines.filter(function(l) { var c = (l.category||'').toLowerCase(); return c !== 'emballage' && c !== 'levering'; });

        // Partitionér efter gruppe + sortér grupper på sort_order
        var groupById = new Map(groups.map(function(g){ return [g.id, g]; }));
        var groupOrder = [];
        var linesByGroup = new Map();
        var ungrouped = [];
        menuLines.forEach(function(l) {
            var gid = l.menu_group_id;
            if (gid && groupById.has(gid)) {
                if (!linesByGroup.has(gid)) { linesByGroup.set(gid, []); groupOrder.push(gid); }
                linesByGroup.get(gid).push(l);
            } else {
                ungrouped.push(l);
            }
        });
        groupOrder.sort(function(a,b){ return (groupById.get(a).sort_order||0) - (groupById.get(b).sort_order||0); });

        var _norm = function(s){ return String(s||'').trim().toLowerCase(); };
        var _renderLine = function(l, group, withPrice) {
            var comment = (l.special_request || '').trim();
            if (comment && group) {
                var n = _norm(comment);
                if (n === _norm(group.title) || n === _norm(group.note)) comment = '';
            }
            var commentPart = comment ? ' (' + comment + ')' : '';
            var pricePart = (withPrice && l.unit_price)
                ? '  ' + (l.quantity * l.unit_price).toLocaleString('da-DK') + ' kr'
                : '';
            return l.quantity + '× ' + l.product_name + commentPart + pricePart;
        };
        var _buildMenu = function(withPrice) {
            var parts = [];
            groupOrder.forEach(function(gid) {
                var g = groupById.get(gid);
                var header = (g.title || g.note || '').trim();
                if (header) parts.push(header + ':');
                linesByGroup.get(gid).forEach(function(l) {
                    parts.push((header ? '  ' : '') + _renderLine(l, g, withPrice));
                });
                parts.push('');
            });
            ungrouped.forEach(function(l) { parts.push(_renderLine(l, null, withPrice)); });
            while (parts.length && parts[parts.length - 1] === '') parts.pop();
            return parts.join('\n');
        };

        // line_total er incl. moms (jf. BON_V2_PRINCIPPER.md sektion 6b)
        var totalInklMoms = lines.reduce(function(s,l) { return s + (l.line_total||0); }, 0);
        var totalExMoms   = window.Moms.inclToExcl(totalInklMoms);
        var moms          = window.Moms.momsOfIncl(totalInklMoms);
        var addrObj = bon.delivery_address || {};
        var addr = typeof addrObj === 'string' ? addrObj : [addrObj.street_name, addrObj.street_nr, addrObj.postal_code, addrObj.city].filter(Boolean).join(' ');
        return {
            kundeNavn: bon.contact_name_full || '', bonNummer: bon.bon_number || '',
            leveringsDato: bon.delivery_date || '', leveringsTidspunkt: bon.delivery_time || bon.pickup_time || '',
            leveringsAdresse: addr, postnummer: (addrObj.postal_code || ''),
            telefon: bon.contact_phone || '', pax: String(bon.pax || ''), firmanavn: bon.company_name || '',
            menuUdenPriser: _buildMenu(false),
            menuMedPriser: _buildMenu(true),
            totalPris: totalInklMoms.toLocaleString('da-DK',{minimumFractionDigits:2})+' kr',
            totalExMoms: totalExMoms.toLocaleString('da-DK',{minimumFractionDigits:2})+' kr',
            momsBeloeb: moms.toLocaleString('da-DK',{minimumFractionDigits:2})+' kr',
            co2PerLinje: menuLines.filter(function(l){return l.co2e;}).map(function(l){return l.product_name+': '+l.co2e+' kg × '+l.quantity+' = '+(l.co2e*l.quantity).toFixed(2);}).join('\n'),
            co2Total: menuLines.reduce(function(s,l){return s+((l.co2e||0)*l.quantity);},0).toFixed(2)+' kg CO₂e',
        };
    };
}

function _drawerApplyTemplate() {
    const sel = document.getElementById('drawerMailTemplate');
    if (!sel || !_drawerInstance) return;
    const key = sel.value;
    if (!key) {
        document.getElementById('drawerMailSubject').value = '';
        document.getElementById('drawerMailBody').value = '';
        return;
    }
    const tmpl = (_drawerInstance._mailTemplates || []).find(t => t.key === key);
    if (!tmpl) return;
    const vars = _drawerInstance._mailVars || {};
    const subst = (str) => {
        let r = str || '';
        for (const [k, v] of Object.entries(vars)) {
            r = r.replace(new RegExp('\\{\\{' + k + '\\}\\}', 'g'), v || '');
        }
        return r;
    };
    document.getElementById('drawerMailSubject').value = subst(tmpl.subject);
    document.getElementById('drawerMailBody').value = subst(tmpl.body_text);
}

// ─── ATTACHMENT HANDLING ────────────────────────────────────────────────────

let _drawerAttachments = [];

function _drawerAttachFile() {
    if (_drawerAttachments.length >= 5) {
        alert('Max 5 vedhæftninger per mail');
        return;
    }
    document.getElementById('drawerMailFile').click();
}

async function _drawerOnFileSelected(input) {
    const file = input.files[0];
    if (!file) return;
    input.value = ''; // reset for re-select

    if (file.size > 10 * 1024 * 1024) {
        alert('Fil er for stor (max 10 MB)');
        return;
    }

    const attachBtn = document.querySelector('.bm-attach');
    if (attachBtn) { attachBtn.disabled = true; attachBtn.textContent = 'Uploader…'; }

    try {
        const entityType = _drawerInstance?.bonId ? 'bon' : 'temp';
        const entityId = _drawerInstance?.bonId || null;
        const result = await uploadAttachment(file, entityType, entityId);
        _drawerAttachments.push(result);
        _drawerRenderAttachmentPills();
    } catch (err) {
        alert('Upload fejl: ' + err.message);
    } finally {
        if (attachBtn) { attachBtn.disabled = false; attachBtn.textContent = '📎 Vedhæft'; }
    }
}

function _drawerRenderAttachmentPills() {
    const el = document.getElementById('drawerMailAttachments');
    if (!el) return;
    el.innerHTML = _drawerAttachments.map((a, i) =>
        '<span class="bm-att-pill">📎 ' + esc(a.filename) + ' (' + Math.round((a.size_bytes || 0) / 1024) + ' KB)'
        + '<span class="bm-att-remove" onclick="_drawerRemoveAttachment(' + i + ')"> ✕</span></span>'
    ).join('');
}

function _drawerRemoveAttachment(index) {
    _drawerAttachments.splice(index, 1);
    _drawerRenderAttachmentPills();
}

// ─── SEND MAIL ──────────────────────────────────────────────────────────────

async function _drawerSendMail() {
    if (!_drawerInstance || !_drawerInstance.bonId) return;
    const to = document.getElementById('drawerMailTo').value.trim();
    const subject = document.getElementById('drawerMailSubject').value.trim();
    const text = document.getElementById('drawerMailBody').value.trim();
    const btn = document.getElementById('drawerMailSendBtn');

    if (!to) { document.getElementById('drawerMailTo').focus(); return; }
    if (!text && !subject) { document.getElementById('drawerMailSubject').focus(); return; }

    btn.disabled = true;
    btn.textContent = 'Sender…';

    try {
        const data = { to, subject, text };
        if (_drawerAttachments.length > 0) {
            data.attachments = _drawerAttachments.map(a => ({ attachment_id: a.attachment_id }));
        }
        await sendBonMail(_drawerInstance.bonId, data);
        // Clear compose
        document.getElementById('drawerMailSubject').value = '';
        document.getElementById('drawerMailBody').value = '';
        document.getElementById('drawerMailTemplate').value = '';
        _drawerAttachments = [];
        _drawerRenderAttachmentPills();
        btn.innerHTML = mailIcon(13) + ' Sendt!';
        setTimeout(() => { btn.innerHTML = mailIcon(13) + ' Send'; btn.disabled = false; }, 2000);
        // Reload mail section
        if (_drawerInstance.data) _drawerInstance._loadMail(_drawerInstance.data);
    } catch (err) {
        console.error('[drawer-mail] Send fejl:', err);
        btn.textContent = 'Fejl — prøv igen';
        btn.disabled = false;
    }
}
