/**
 * shared/kunde_soeg.js
 * ════════════════════════════════════════════════════════════
 * Genbrugelig kunde/firma-søgekomponent.
 *
 * States: IDLE → SEARCHING → RESULTS → SELECTED
 *                                    → CREATING (firma → kontakt)
 *
 * Brug:
 *   const soeg = new KundeSoeg({
 *     container: document.getElementById('kunde-soeg-container'),
 *     onSelect: (data) => console.log('Valgt:', data)
 *   });
 * ════════════════════════════════════════════════════════════
 */

export class KundeSoeg {
    constructor({ container, onSelect }) {
        this.container = container;
        this.onSelect = onSelect;
        this.state = 'IDLE';
        this.debounceTimer = null;
        this.selected = null;
        this.results = [];
        this.createStep = 'firma'; // 'firma' | 'kontakt'
        this.newFirma = {};
        this.newKontakt = {};
        this.isPrivat = false;
        this.cvrLoading = false;
        this.searchQuery = '';
        this.render();
    }

    setState(state) {
        this.state = state;
        this.render();
    }

    /* ══════════════════════════════════════════════════════
       SEARCH
       ══════════════════════════════════════════════════════ */

    scheduleSearch(q) {
        this.searchQuery = q;
        clearTimeout(this.debounceTimer);
        if (q.length < 2) {
            this.setState('IDLE');
            return;
        }
        this.setState('SEARCHING');
        this.debounceTimer = setTimeout(() => this.doSearch(q), 250);
    }

    async doSearch(q) {
        try {
            const res = await fetch(`/api/customers?q=${encodeURIComponent(q)}`);
            const data = await res.json();
            this.results = data;
            this.setState('RESULTS');
        } catch (err) {
            console.error('Søgefejl:', err);
            this.results = [];
            this.setState('RESULTS');
        }
    }

    /* ══════════════════════════════════════════════════════
       SELECT / CLEAR
       ══════════════════════════════════════════════════════ */

    select(item) {
        this.selected = {
            customer_id: item.customer_id,
            company_id: item.company_id || null,
            customer_name: `${item.first_name} ${item.last_name || ''}`.trim(),
            company_name: item.company_name || null,
            phone: item.phone,
            email: item.email,
            default_payment_type: item.default_payment_type || null,
            default_price_category_id: item.default_price_category_id || null
        };
        this.setState('SELECTED');
        this.onSelect(this.selected);
    }

    clear() {
        this.selected = null;
        this.searchQuery = '';
        this.setState('IDLE');
        this.onSelect(null);
    }

    /* ══════════════════════════════════════════════════════
       CREATE — Step A: Firma
       ══════════════════════════════════════════════════════ */

    startCreate() {
        this.createStep = 'firma';
        this.newFirma = {};
        this.newKontakt = {};
        this.isPrivat = false;
        this.cvrLoading = false;
        this.setState('CREATING');
    }

    async cvrLookup(cvr) {
        cvr = cvr.replace(/\D/g, '');
        if (cvr.length !== 8) return;
        this.cvrLoading = true;
        this.render();
        try {
            const res = await fetch(`/api/cvr/${cvr}`);
            if (!res.ok) throw new Error('Ikke fundet');
            const data = await res.json();
            this.newFirma.name = data.name || this.newFirma.name || '';
            this.newFirma.cvr = data.cvr || cvr;
            this.newFirma.phone = data.phone || this.newFirma.phone || '';
            this.newFirma.email = data.email || this.newFirma.email || '';
            this.newFirma.address = data.address || '';
            this.newFirma.zipcode = data.zipcode || '';
            this.newFirma.city = data.city || '';
        } catch (err) {
            console.warn('CVR-opslag fejlede:', err.message);
        }
        this.cvrLoading = false;
        this.render();
    }

    goToKontakt() {
        this.createStep = 'kontakt';
        this.render();
    }

    goBackToFirma() {
        this.createStep = 'firma';
        this.render();
    }

    /* ══════════════════════════════════════════════════════
       CREATE — Step B: Kontakt → Gem
       ══════════════════════════════════════════════════════ */

    async saveNew() {
        const kontakt = this.newKontakt;
        if (!kontakt.first_name || !kontakt.first_name.trim()) {
            alert('Fornavn er p\u00e5kr\u00e6vet');
            return;
        }

        try {
            let company_id = null;
            let company_name = null;

            // Opret firma hvis ikke privatkunde
            if (!this.isPrivat && this.newFirma.name) {
                const compRes = await fetch('/api/companies', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: this.newFirma.name,
                        cvr: this.newFirma.cvr || null,
                        phone: this.newFirma.phone || null,
                        email: this.newFirma.email || null
                    })
                });
                const compData = await compRes.json();
                if (compData.error) throw new Error(compData.error);
                company_id = compData.id;
                company_name = this.newFirma.name;
            }

            // Opret kunde
            const custRes = await fetch('/api/customers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    first_name: kontakt.first_name.trim(),
                    last_name: kontakt.last_name || null,
                    phone: kontakt.phone || null,
                    email: kontakt.email || null,
                    company_id
                })
            });
            const custData = await custRes.json();
            if (custData.error) throw new Error(custData.error);

            // V\u00e6lg den nye kunde
            this.selected = {
                customer_id: custData.id,
                company_id,
                customer_name: `${kontakt.first_name} ${kontakt.last_name || ''}`.trim(),
                company_name,
                phone: kontakt.phone || null,
                email: kontakt.email || null,
                default_payment_type: null,
                default_price_category_id: null
            };
            this.setState('SELECTED');
            this.onSelect(this.selected);
        } catch (err) {
            console.error('Oprettelsesfejl:', err);
            alert('Fejl ved oprettelse: ' + err.message);
        }
    }

    cancelCreate() {
        this.searchQuery = '';
        this.setState('IDLE');
    }

    /* ══════════════════════════════════════════════════════
       RENDER
       ══════════════════════════════════════════════════════ */

    render() {
        const el = this.container;
        el.innerHTML = '';
        el.classList.add('ks-wrapper');

        switch (this.state) {
            case 'IDLE':
            case 'SEARCHING':
            case 'RESULTS':
                this.renderSearch(el);
                break;
            case 'SELECTED':
                this.renderSelected(el);
                break;
            case 'CREATING':
                if (this.createStep === 'firma') {
                    this.renderCreateFirma(el);
                } else {
                    this.renderCreateKontakt(el);
                }
                break;
        }
    }

    renderSearch(el) {
        // S\u00f8gefelt
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'ks-input';
        input.placeholder = 'S\u00f8g p\u00e5 navn, firma eller CVR...';
        input.value = this.searchQuery;
        input.addEventListener('input', (e) => this.scheduleSearch(e.target.value));
        el.appendChild(input);

        // Spinner
        if (this.state === 'SEARCHING') {
            const spinner = document.createElement('div');
            spinner.className = 'ks-spinner';
            spinner.textContent = 'S\u00f8ger...';
            el.appendChild(spinner);
        }

        // Resultater
        if (this.state === 'RESULTS') {
            const dropdown = document.createElement('div');
            dropdown.className = 'ks-dropdown';

            if (this.results.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'ks-empty';
                empty.textContent = 'Ingen resultater';
                dropdown.appendChild(empty);
            } else {
                for (const item of this.results) {
                    const row = document.createElement('div');
                    row.className = 'ks-result';
                    row.addEventListener('click', () => this.select(item));

                    if (item.company_name) {
                        const firma = document.createElement('div');
                        firma.className = 'ks-result-firma';
                        firma.textContent = item.company_name;
                        row.appendChild(firma);
                    }

                    const kontakt = document.createElement('div');
                    kontakt.className = 'ks-result-kontakt';
                    const name = `${item.first_name} ${item.last_name || ''}`.trim();
                    const parts = [name];
                    if (item.email) parts.push(item.email);
                    kontakt.textContent = parts.join('  \u00b7  ');
                    row.appendChild(kontakt);

                    dropdown.appendChild(row);
                }
            }

            // "Opret ny"-knap
            const createBtn = document.createElement('div');
            createBtn.className = 'ks-create-btn';
            createBtn.textContent = '+ Opret ny kunde';
            createBtn.addEventListener('click', () => this.startCreate());
            dropdown.appendChild(createBtn);

            el.appendChild(dropdown);
        }

        // Fokus\u00e9r input efter render
        requestAnimationFrame(() => input.focus());
    }

    renderSelected(el) {
        const pill = document.createElement('div');
        pill.className = 'ks-selected';

        const text = document.createElement('span');
        const parts = [];
        if (this.selected.company_name) parts.push(this.selected.company_name);
        parts.push(this.selected.customer_name);
        text.textContent = parts.join(' \u2014 ');
        pill.appendChild(text);

        const clearBtn = document.createElement('button');
        clearBtn.className = 'ks-selected-clear';
        clearBtn.textContent = '\u2715';
        clearBtn.title = 'Fjern valg';
        clearBtn.addEventListener('click', () => this.clear());
        pill.appendChild(clearBtn);

        el.appendChild(pill);
    }

    renderCreateFirma(el) {
        const form = document.createElement('div');
        form.className = 'ks-form';

        const title = document.createElement('h3');
        title.className = 'ks-form-title';
        title.textContent = 'Nyt firma';
        form.appendChild(title);

        // CVR-felt med opslags-knap
        const cvrRow = document.createElement('div');
        cvrRow.className = 'ks-form-field ks-cvr-row';

        const cvrLabel = document.createElement('label');
        cvrLabel.textContent = 'CVR-nummer';
        cvrRow.appendChild(cvrLabel);

        const cvrInner = document.createElement('div');
        cvrInner.className = 'ks-cvr-inner';

        const cvrInput = document.createElement('input');
        cvrInput.type = 'text';
        cvrInput.placeholder = '12345678';
        cvrInput.value = this.newFirma.cvr || '';
        cvrInput.maxLength = 8;
        cvrInput.addEventListener('input', (e) => { this.newFirma.cvr = e.target.value; });
        cvrInner.appendChild(cvrInput);

        const cvrBtn = document.createElement('button');
        cvrBtn.className = 'ks-cvr-btn';
        cvrBtn.textContent = this.cvrLoading ? '...' : 'Sl\u00e5 op';
        cvrBtn.disabled = this.cvrLoading;
        cvrBtn.addEventListener('click', () => this.cvrLookup(this.newFirma.cvr || ''));
        cvrInner.appendChild(cvrBtn);

        cvrRow.appendChild(cvrInner);
        form.appendChild(cvrRow);

        // Felter
        const fields = [
            { key: 'name', label: 'Firmanavn *', required: true },
            { key: 'phone', label: 'Telefon' },
            { key: 'email', label: 'Email' }
        ];

        for (const f of fields) {
            form.appendChild(this.createField(f.label, this.newFirma[f.key] || '', (val) => {
                this.newFirma[f.key] = val;
            }));
        }

        // Privatkunde-checkbox
        const privatRow = document.createElement('div');
        privatRow.className = 'ks-form-field ks-privat-row';
        const privatLabel = document.createElement('label');
        privatLabel.className = 'ks-privat-label';

        const privatCheck = document.createElement('input');
        privatCheck.type = 'checkbox';
        privatCheck.checked = this.isPrivat;
        privatCheck.addEventListener('change', (e) => {
            this.isPrivat = e.target.checked;
            if (this.isPrivat) {
                this.createStep = 'kontakt';
                this.render();
            }
        });
        privatLabel.appendChild(privatCheck);
        privatLabel.appendChild(document.createTextNode(' Privatkunde (intet firma)'));
        privatRow.appendChild(privatLabel);
        form.appendChild(privatRow);

        // Knapper
        const actions = document.createElement('div');
        actions.className = 'ks-form-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'ks-btn-secondary';
        cancelBtn.textContent = 'Annuller';
        cancelBtn.addEventListener('click', () => this.cancelCreate());
        actions.appendChild(cancelBtn);

        const nextBtn = document.createElement('button');
        nextBtn.className = 'ks-btn-primary';
        nextBtn.textContent = 'N\u00e6ste \u2192';
        nextBtn.addEventListener('click', () => {
            if (!this.newFirma.name || !this.newFirma.name.trim()) {
                alert('Firmanavn er p\u00e5kr\u00e6vet');
                return;
            }
            this.goToKontakt();
        });
        actions.appendChild(nextBtn);

        form.appendChild(actions);
        el.appendChild(form);
    }

    renderCreateKontakt(el) {
        const form = document.createElement('div');
        form.className = 'ks-form';

        const title = document.createElement('h3');
        title.className = 'ks-form-title';
        const firmaInfo = this.isPrivat ? '(privatkunde)' : `(${this.newFirma.name || 'firma'})`;
        title.textContent = `Ny kontakt  ${firmaInfo}`;
        form.appendChild(title);

        const fields = [
            { key: 'first_name', label: 'Fornavn *' },
            { key: 'last_name', label: 'Efternavn' },
            { key: 'phone', label: 'Telefon' },
            { key: 'email', label: 'Email' }
        ];

        for (const f of fields) {
            form.appendChild(this.createField(f.label, this.newKontakt[f.key] || '', (val) => {
                this.newKontakt[f.key] = val;
            }));
        }

        // Knapper
        const actions = document.createElement('div');
        actions.className = 'ks-form-actions';

        if (!this.isPrivat) {
            const backBtn = document.createElement('button');
            backBtn.className = 'ks-btn-secondary';
            backBtn.textContent = '\u2190 Tilbage';
            backBtn.addEventListener('click', () => this.goBackToFirma());
            actions.appendChild(backBtn);
        } else {
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'ks-btn-secondary';
            cancelBtn.textContent = 'Annuller';
            cancelBtn.addEventListener('click', () => this.cancelCreate());
            actions.appendChild(cancelBtn);
        }

        const saveBtn = document.createElement('button');
        saveBtn.className = 'ks-btn-primary';
        saveBtn.textContent = 'Opret';
        saveBtn.addEventListener('click', () => this.saveNew());
        actions.appendChild(saveBtn);

        form.appendChild(actions);
        el.appendChild(form);
    }

    /* ══════════════════════════════════════════════════════
       HELPERS
       ══════════════════════════════════════════════════════ */

    createField(label, value, onChange) {
        const wrap = document.createElement('div');
        wrap.className = 'ks-form-field';

        const lbl = document.createElement('label');
        lbl.textContent = label;
        wrap.appendChild(lbl);

        const input = document.createElement('input');
        input.type = 'text';
        input.value = value;
        input.addEventListener('input', (e) => onChange(e.target.value));
        wrap.appendChild(input);

        return wrap;
    }

    /** Programmatisk s\u00e6t valgt kunde (bruges n\u00e5r man redigerer en bon) */
    setSelected(data) {
        this.selected = data;
        this.setState('SELECTED');
    }

    /** Hent den valgte kundes data */
    getSelected() {
        return this.selected;
    }
}
