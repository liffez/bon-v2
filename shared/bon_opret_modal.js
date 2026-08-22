/**
 * shared/bon_opret_modal.js
 * ════════════════════════════════════════════════════════════
 * Hurtig opret-modal til nye bonner.
 * Obligatorisk: kunde, leveringsdato, leveringstid, delivery_type.
 * Valgfrit: pax, priskategori.
 *
 * Kræver: utils.js, api.js, kunde_soeg.js (alle globale scripts)
 *
 * Brug:
 *   const modal = new BonOpretModal({ onCreated: (bonId) => ... });
 *   modal.open();
 * ════════════════════════════════════════════════════════════
 */

class BonOpretModal {
    constructor({ onCreated }) {
        this.onCreated = onCreated;
        this.selectedCustomer = null;
        this.priceCategories = [];
        this._buildDOM();
        this._loadPriceCategories();
    }

    /* ══════════════════════════════════════════════════════
       DOM
       ══════════════════════════════════════════════════════ */

    _buildDOM() {
        this.overlay = document.createElement('div');
        this.overlay.className = 'bon-opret-overlay';
        this.overlay.style.display = 'none';

        // Kvartersintervaller 07:00 - 20:00
        const timeOptions = [];
        for (let h = 7; h <= 20; h++) {
            for (let m = 0; m < 60; m += 15) {
                const t = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
                timeOptions.push(`<option value="${t}">${t}</option>`);
            }
        }

        this.overlay.innerHTML = `
            <div class="bon-opret-modal">
                <div class="bon-opret-header">
                    <h2>Ny bon</h2>
                    <button class="bon-opret-close" type="button">&times;</button>
                </div>
                <div class="bon-opret-body">
                    <label class="bon-opret-label">Kunde</label>
                    <div class="bon-opret-kunde-container"></div>

                    <label class="bon-opret-label">Levering</label>
                    <div class="bon-opret-row">
                        <input type="date" class="bon-opret-dato" required>
                        <select class="bon-opret-tid">
                            <option value="">Tid...</option>
                            ${timeOptions.join('')}
                        </select>
                    </div>

                    <label class="bon-opret-label">Type</label>
                    <div class="bon-opret-type-toggle">
                        <button type="button" class="bon-opret-type active" data-type="delivery">Levering</button>
                        <button type="button" class="bon-opret-type" data-type="pickup">Afhentning</button>
                        <button type="button" class="bon-opret-type" data-type="event">Event</button>
                    </div>

                    <label class="bon-opret-label">Pax &amp; Priskategori</label>
                    <div class="bon-opret-row">
                        <input type="number" class="bon-opret-pax" placeholder="Pax" min="0">
                        <select class="bon-opret-priskategori">
                            <option value="">Vælg...</option>
                        </select>
                    </div>

                    <div class="bon-opret-error" style="display:none"></div>
                </div>
                <div class="bon-opret-footer">
                    <button type="button" class="btn-annuller">Annuller</button>
                    <button type="button" class="btn-opret">Opret bon</button>
                </div>
            </div>
        `;

        document.body.appendChild(this.overlay);

        // KundeSoeg
        const kundeContainer = this.overlay.querySelector('.bon-opret-kunde-container');
        this.kundeSoeg = new KundeSoeg({
            container: kundeContainer,
            onSelect: (data) => {
                this.selectedCustomer = data;
                if (data) {
                    // Sæt default priskategori fra firma
                    if (data.default_price_category_id) {
                        this.overlay.querySelector('.bon-opret-priskategori').value = data.default_price_category_id;
                    }
                }
            }
        });

        // Type toggle
        this.overlay.querySelectorAll('.bon-opret-type').forEach(btn => {
            btn.addEventListener('click', () => {
                this.overlay.querySelectorAll('.bon-opret-type').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        // Close handlers
        this.overlay.querySelector('.bon-opret-close').addEventListener('click', () => this.close());
        this.overlay.querySelector('.btn-annuller').addEventListener('click', () => this.close());
        closeOnOutsideClick(this.overlay, () => this.close());

        // Priskategori change → hide/show fields for produktion
        this.overlay.querySelector('.bon-opret-priskategori').addEventListener('change', () => this._onPriceCategoryChange());

        // Submit
        this.overlay.querySelector('.btn-opret').addEventListener('click', () => this._submit());

        // Escape
        this._onKeydown = (e) => {
            if (e.key === 'Escape' && this.overlay.style.display !== 'none') this.close();
        };
        document.addEventListener('keydown', this._onKeydown);
    }

    async _loadPriceCategories() {
        try {
            this.priceCategories = await fetchPriceCategories();
            const sel = this.overlay.querySelector('.bon-opret-priskategori');
            sel.innerHTML = '<option value="">Vælg...</option>';
            for (const pc of this.priceCategories) {
                sel.innerHTML += `<option value="${pc.id}">${esc(pc.label)}</option>`;
            }
            // Default til 'catering' hvis den findes
            const catering = this.priceCategories.find(p => p.code === 'catering');
            if (catering) sel.value = catering.id;
        } catch (err) {
            console.error('Kunne ikke hente priskategorier:', err);
        }
    }

    /* ══════════════════════════════════════════════════════
       OPEN / CLOSE
       ══════════════════════════════════════════════════════ */

    open() {
        this._reset();
        this.overlay.style.display = 'flex';
        // Sæt default dato til i morgen. offsetISO regner på den danske
        // kalenderdato — lokal setDate() + UTC-udtræk gav i nat en bon
        // med i DAG som leveringsdato.
        this.overlay.querySelector('.bon-opret-dato').value = offsetISO(1);
        // Sæt default tid 11:00
        this.overlay.querySelector('.bon-opret-tid').value = '11:00';
        // Focus dato
        setTimeout(() => this.overlay.querySelector('.bon-opret-dato').focus(), 50);
    }

    close() {
        this.overlay.style.display = 'none';
    }

    _reset() {
        this.selectedCustomer = null;
        this.kundeSoeg.clear();
        this.overlay.querySelector('.bon-opret-dato').value = '';
        this.overlay.querySelector('.bon-opret-tid').value = '';
        this.overlay.querySelector('.bon-opret-pax').value = '';
        this.overlay.querySelectorAll('.bon-opret-type').forEach(b => b.classList.remove('active'));
        this.overlay.querySelector('[data-type="delivery"]').classList.add('active');
        // Reset priskategori til catering default
        const catering = this.priceCategories.find(p => p.code === 'catering');
        if (catering) this.overlay.querySelector('.bon-opret-priskategori').value = catering.id;
        this._hideError();
        // Reset visibility (vigtigt efter produktion-mode)
        this._onPriceCategoryChange();
    }

    _isProductionMode() {
        const sel = this.overlay.querySelector('.bon-opret-priskategori');
        const pcId = parseInt(sel.value);
        const pc = this.priceCategories.find(p => p.id === pcId);
        return pc && pc.code === 'produktion';
    }

    _onPriceCategoryChange() {
        const isProd = this._isProductionMode();
        // Hide/show sections
        const kundeLabel = this.overlay.querySelector('.bon-opret-label'); // first label = "Kunde"
        const kundeContainer = this.overlay.querySelector('.bon-opret-kunde-container');
        const typeLabel = this.overlay.querySelectorAll('.bon-opret-label')[2]; // "Type"
        const typeToggle = this.overlay.querySelector('.bon-opret-type-toggle');

        // Find all labels
        const labels = this.overlay.querySelectorAll('.bon-opret-label');
        // labels[0] = Kunde, labels[1] = Levering, labels[2] = Type, labels[3] = Pax & Priskategori

        // Hide Kunde
        if (labels[0]) labels[0].style.display = isProd ? 'none' : '';
        if (kundeContainer) kundeContainer.style.display = isProd ? 'none' : '';

        // Hide Type
        if (labels[2]) labels[2].style.display = isProd ? 'none' : '';
        if (typeToggle) typeToggle.style.display = isProd ? 'none' : '';

        // Change "Levering" label to "Dato"
        if (labels[1]) labels[1].textContent = isProd ? 'Produktionsdato' : 'Levering';

        // Change tid to optional
        const tidSel = this.overlay.querySelector('.bon-opret-tid');
        if (isProd && tidSel && !tidSel.value) tidSel.value = '08:00';
    }

    /* ══════════════════════════════════════════════════════
       SUBMIT
       ══════════════════════════════════════════════════════ */

    async _submit() {
        this._hideError();

        const isProd = this._isProductionMode();

        // Valider
        if (!isProd && !this.selectedCustomer) return this._showError('Vælg en kunde');
        const dato = this.overlay.querySelector('.bon-opret-dato').value;
        if (!dato) return this._showError(isProd ? 'Vælg produktionsdato' : 'Vælg leveringsdato');
        const tid = this.overlay.querySelector('.bon-opret-tid').value;

        const deliveryType = this.overlay.querySelector('.bon-opret-type.active')?.dataset.type || 'delivery';
        const pax = parseInt(this.overlay.querySelector('.bon-opret-pax').value) || 0;
        const priceCatId = parseInt(this.overlay.querySelector('.bon-opret-priskategori').value) || null;

        const payload = isProd ? {
            delivery_date: dato,
            delivery_time: tid || null,
            delivery_type: 'pickup',
            customer_collects: 1,
            kitchen_selects: 1,
            is_internal: 1,
            pax: pax,
            price_category_id: priceCatId,
            status_id: 3, // GODKENDT
            internal_notes: 'Produktionsbon',
        } : {
            customer_id: this.selectedCustomer.customer_id,
            company_id: this.selectedCustomer.company_id || null,
            delivery_date: dato,
            delivery_time: tid || null,
            delivery_type: deliveryType,
            pax: pax,
            price_category_id: priceCatId,
            payment_type: this.selectedCustomer.default_payment_type || 'invoice',
        };

        // Disable knap under submit
        const btn = this.overlay.querySelector('.btn-opret');
        btn.disabled = true;
        btn.textContent = 'Opretter...';

        try {
            const result = await createBon(payload);
            this.close();
            if (this.onCreated) this.onCreated(result.id);
        } catch (err) {
            this._showError(err.message || 'Kunne ikke oprette bon');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Opret bon';
        }
    }

    _showError(msg) {
        const el = this.overlay.querySelector('.bon-opret-error');
        el.textContent = msg;
        el.style.display = 'block';
    }

    _hideError() {
        this.overlay.querySelector('.bon-opret-error').style.display = 'none';
    }
}
