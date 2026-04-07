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
                <button class="drawer-close" type="button">&times;</button>
            </div>

            <div class="drawer-body">
                <!-- STATUS -->
                <div class="drawer-section">
                    <div class="drawer-status-bar"></div>
                </div>

                <!-- LEVERING -->
                <div class="drawer-section">
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
                        <label class="drawer-sublabel">Leveringsmetode</label>
                        <select class="drawer-field" data-field="delivery_method">
                            <option value="">Vælg...</option>
                            <option value="cykel">Cykel</option>
                            <option value="taxa">Taxa</option>
                            <option value="volvo">Volvo</option>
                            <option value="afhentning">Afhentning</option>
                        </select>
                    </div>
                </div>

                <!-- KUNDE -->
                <div class="drawer-section">
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
                <div class="drawer-section drawer-firma-section">
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
                        ✉ Mail <span class="drawer-mail-badge" id="drawerMailBadge"></span>
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
                                    <button type="button" class="bm-send" id="drawerMailSendBtn" onclick="_drawerSendMail()">✉ Send</button>
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
        this.overlayEl.addEventListener('click', () => this.hide());

        // Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.el.classList.contains('open')) this.hide();
        });

        // Dirty tracking on all fields
        this.el.querySelectorAll('.drawer-field').forEach(field => {
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

    async load(bonId) {
        this.bonId = bonId;
        this.dirty = false;
        this._pendingChanges = {};
        try {
            this.data = await fetchBon(bonId);
            this._render();
        } catch (err) {
            console.error('Kunne ikke hente bon:', err);
        }
    }

    _render() {
        const d = this.data;
        if (!d) return;

        // Header
        this.el.querySelector('.drawer-title').textContent = `Bon #${d.bon_number}`;
        this.el.querySelector('.drawer-header').classList.remove('has-changes');
        this.el.querySelector('.btn-drawer-gem').disabled = true;

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
        this._setFieldValue('delivery_method', d.delivery_method || '');

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

        this.dirty = false;
        this._pendingChanges = {};
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

            // Render history
            const allMsgs = [];
            (mailData.threads || []).forEach(t => (t.messages || []).forEach(m => allMsgs.push(m)));
            allMsgs.sort((a, b) => new Date(b.received_at || b.sent_at || b.created_at) - new Date(a.received_at || a.sent_at || a.created_at));

            const unread = allMsgs.filter(m => m.direction === 'in' && !m.is_read).length;
            if (badgeEl) badgeEl.textContent = unread ? unread + ' ulæst' : '';

            if (allMsgs.length === 0) {
                histEl.innerHTML = '<div style="color:var(--color-text-dim);font-size:12px;padding:4px;font-style:italic">Ingen mails endnu</div>';
            } else {
                histEl.innerHTML = allMsgs.map(m => {
                    const isIn = m.direction === 'in';
                    const isUnread = isIn && !m.is_read;
                    const from = isIn ? (m.from_name || m.from_email || '?') : 'Ristet Rug';
                    const dateStr = _fmtMailDate(m.received_at || m.sent_at || m.created_at);
                    const body = (m.body_text || '').slice(0, 150).replace(/\n/g, ' ');
                    return '<div class="bm-msg ' + (isIn ? 'bm-in' : 'bm-out') + (isUnread ? ' bm-unread' : '') + '"'
                        + (isUnread ? ' onclick="_markMailRead(\'' + this.bonId + '\',' + m.id + ',this)"' : '') + '>'
                        + '<div class="bm-msg-header"><span class="bm-msg-from">' + (isIn ? '← ' : '→ ') + esc(from) + '</span><span class="bm-msg-date">' + dateStr + '</span></div>'
                        + '<div class="bm-msg-subject">' + esc(m.subject || '') + '</div>'
                        + '<div class="bm-msg-body">' + esc(body) + (body.length >= 150 ? '…' : '') + '</div>'
                        + (m.attachments && m.attachments.filter(a => a.id).length
                            ? '<div class="bm-msg-attachments">' + m.attachments.filter(a => a.id).map(a =>
                                '<a href="' + mailAttachmentUrl(a.id) + '" class="bm-msg-att" target="_blank">📎 ' + esc(a.filename) + ' (' + Math.round((a.size_bytes||0)/1024) + ' KB)</a>'
                            ).join('') + '</div>'
                            : '')
                        + '</div>';
                }).join('');
            }
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
        flash.textContent = '\u2713 Status gemt';
        const bar = this.el.querySelector('.drawer-status-bar');
        bar.parentElement.appendChild(flash);
        setTimeout(() => flash.remove(), 2000);
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
            var special = l.special_request ? '<div class="drawer-line-special">' + _esc(l.special_request) + '</div>' : '';
            var price = l.line_total != null ? l.line_total + ' kr' : '';
            return '<div class="drawer-line-item" data-line-id="' + l.id + '">' +
                '<span class="drawer-line-qty">' + (l.quantity || 1) + '</span>' +
                '<span class="drawer-line-name">' + _esc(l.product_name || '') + special + '</span>' +
                '<span class="drawer-line-price">' + price + '</span>' +
                '<button class="drawer-line-del" title="Fjern">&times;</button>' +
            '</div>';
        }).join('');

        // Delete line handlers
        var self = this;
        list.querySelectorAll('.drawer-line-del').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var lineId = btn.closest('.drawer-line-item').dataset.lineId;
                self._deleteLine(lineId);
            });
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
    }

    _toggleDeliveryFields(type) {
        const deliveryFields = this.el.querySelector('.drawer-delivery-fields');
        deliveryFields.style.display = type === 'delivery' ? '' : 'none';
    }

    /* ══════════════════════════════════════════════════════
       DIRTY TRACKING
       ══════════════════════════════════════════════════════ */

    _markDirty() {
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
            'delivery_notes', 'delivery_method',
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
        if (!confirm('Er du sikker på du vil slette denne bon? Handlingen kan ikke fortrydes.')) return;
        try {
            await patchBonStatus(this.bonId, 'AFLYST');
            this.hide();
        } catch (err) {
            alert(err.message || 'Kunne ikke slette/aflyse bon');
        }
    }

    /* ══════════════════════════════════════════════════════
       SHOW / HIDE
       ══════════════════════════════════════════════════════ */

    /** Convenience: load + show i ét kald */
    async open(bonId) {
        await this.load(bonId);
        this.show();
    }

    show() {
        this.el.classList.add('open');
        this.overlayEl.classList.add('open');
        document.body.style.overflow = 'hidden';
    }

    hide() {
        if (this.dirty && !confirm('Du har ugemte ændringer. Luk alligevel?')) return;
        this.el.classList.remove('open');
        this.overlayEl.classList.remove('open');
        document.body.style.overflow = '';
        this.dirty = false;
    }

    get isOpen() {
        return this.el.classList.contains('open');
    }

    /* ══════════════════════════════════════════════════════
       SSE
       ══════════════════════════════════════════════════════ */

    _bindSSE() {
        window.addEventListener('sse:bon_updated', (e) => {
            const data = e.detail || {};
            if ((data.id == this.bonId || data.bon_id == this.bonId) && !this.dirty) {
                this.load(this.bonId);
            }
        });
        window.addEventListener('sse:bon_status', (e) => {
            const data = e.detail || {};
            if (data.bon_id == this.bonId && !this.dirty) {
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

        // Hent fuld adresse-data
        try {
            const resp = await fetch(item.adresse?.href || `https://api.dataforsyningen.dk/adresser/${item.adresse?.id}`);
            const addr = await resp.json();

            const addressData = {
                street_name: addr.vejnavn || item.tekst.split(' ')[0],
                street_nr: addr.husnr || '',
                postal_code: addr.postnr || '',
                city: addr.postnrnavn || '',
                lat: addr.adgangsadresse?.adgangspunkt?.koordinater?.[1] || null,
                lon: addr.adgangsadresse?.adgangspunkt?.koordinater?.[0] || null,
            };

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
        var d = new Date(isoStr);
        return d.getDate() + '/' + (d.getMonth()+1) + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    };
}
if (typeof _buildMailVars === 'undefined') {
    var _buildMailVars = function(bon) {
        var lines = bon.lines || [];
        var menuLines = lines.filter(function(l) { var c = (l.category||'').toLowerCase(); return c !== 'emballage' && c !== 'levering'; });
        var totalExMoms = lines.reduce(function(s,l) { return s + (l.line_total||0); }, 0);
        var moms = Math.round(totalExMoms * 0.25 * 100) / 100;
        var addrObj = bon.delivery_address || {};
        var addr = typeof addrObj === 'string' ? addrObj : [addrObj.street_name, addrObj.street_nr, addrObj.postal_code, addrObj.city].filter(Boolean).join(' ');
        return {
            kundeNavn: bon.contact_name_full || '', bonNummer: bon.bon_number || '',
            leveringsDato: bon.delivery_date || '', leveringsTidspunkt: bon.delivery_time || bon.pickup_time || '',
            leveringsAdresse: addr, postnummer: (addrObj.postal_code || ''),
            telefon: bon.contact_phone || '', pax: String(bon.pax || ''), firmanavn: bon.company_name || '',
            menuUdenPriser: menuLines.map(function(l) { return l.quantity + '× ' + l.product_name; }).join('\n'),
            menuMedPriser: menuLines.map(function(l) { var p = l.unit_price ? (l.quantity*l.unit_price).toLocaleString('da-DK')+' kr' : ''; return l.quantity+'× '+l.product_name+(p?' '+p:''); }).join('\n'),
            totalPris: (totalExMoms+moms).toLocaleString('da-DK',{minimumFractionDigits:2})+' kr',
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
        btn.textContent = '✉ Sendt!';
        setTimeout(() => { btn.textContent = '✉ Send'; btn.disabled = false; }, 2000);
        // Reload mail section
        if (_drawerInstance.data) _drawerInstance._loadMail(_drawerInstance.data);
    } catch (err) {
        console.error('[drawer-mail] Send fejl:', err);
        btn.textContent = 'Fejl — prøv igen';
        btn.disabled = false;
    }
}
