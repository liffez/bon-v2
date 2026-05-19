/**
 * shared/kunde_soeg.js
 * ════════════════════════════════════════════════════════════
 * Genbrugelig kunde/firma-søgekomponent.
 *
 * States: IDLE → SEARCHING → RESULTS → SELECTED
 *                                    → CREATING (kontakt + firma i ét trin)
 *
 * Brug:
 *   const soeg = new KundeSoeg({
 *     container: document.getElementById('kunde-soeg-container'),
 *     onSelect: (data) => console.log('Valgt:', data)
 *   });
 * ════════════════════════════════════════════════════════════
 */

class KundeSoeg {
    constructor({ container, onSelect }) {
        this.container = container;
        this.onSelect = onSelect;
        this.state = 'IDLE';
        this.debounceTimer = null;
        this.selected = null;
        this.results = [];
        // Single-step opret-flow
        this.newKontakt = {};
        this.firmaMode = 'none';      // 'none' | 'existing' | 'new'
        this.firmaSearchQuery = '';
        this.firmaResults = [];
        this.firmaDebounceTimer = null;
        this.firmaSearching = false;
        this.firmaShowResults = false;
        this.selectedFirma = null;    // { id, name, cvr, ... } når mode === 'existing'
        this.newFirma = {};            // når mode === 'new'
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
            company_cvr: item.cvr || null,
            company_city: item.company_city || null,
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
       CREATE — kontakt først, firma efter
       ══════════════════════════════════════════════════════ */

    startCreate() {
        this.newKontakt = {};
        this.firmaMode = 'none';
        this.firmaSearchQuery = '';
        this.firmaResults = [];
        this.firmaShowResults = false;
        this.selectedFirma = null;
        this.newFirma = {};
        this.cvrLoading = false;
        this.setState('CREATING');
    }

    /* ── Firma-søgning (i CREATING state) ────────────────── */

    scheduleFirmaSearch(q) {
        this.firmaSearchQuery = q;
        clearTimeout(this.firmaDebounceTimer);
        if (q.length < 2) {
            this.firmaResults = [];
            this.firmaShowResults = false;
            this.firmaSearching = false;
            this.updateFirmaDropdown();
            return;
        }
        this.firmaSearching = true;
        this.firmaShowResults = true;
        this.updateFirmaDropdown();
        this.firmaDebounceTimer = setTimeout(() => this.doFirmaSearch(q), 250);
    }

    async doFirmaSearch(q) {
        try {
            const res = await fetch(`/api/companies?q=${encodeURIComponent(q)}`);
            const data = await res.json();
            this.firmaResults = data;
        } catch (err) {
            console.error('Firma-søgefejl:', err);
            this.firmaResults = [];
        }
        this.firmaSearching = false;
        this.updateFirmaDropdown();
    }

    pickExistingFirma(company) {
        this.firmaMode = 'existing';
        this.selectedFirma = company;
        this.firmaShowResults = false;
        this.firmaSearchQuery = '';
        this.firmaResults = [];
        this.render();
    }

    startNewFirma(initialName) {
        this.firmaMode = 'new';
        this.newFirma = { name: initialName || this.firmaSearchQuery || '' };
        this.firmaShowResults = false;
        this.render();
    }

    clearFirmaSelection() {
        this.firmaMode = 'none';
        this.selectedFirma = null;
        this.newFirma = {};
        this.firmaSearchQuery = '';
        this.firmaResults = [];
        this.firmaShowResults = false;
        this.render();
    }

    setPrivat(isPrivat) {
        if (isPrivat) {
            this.firmaMode = 'privat';
            this.selectedFirma = null;
            this.newFirma = {};
            this.firmaSearchQuery = '';
            this.firmaResults = [];
            this.firmaShowResults = false;
        } else {
            this.firmaMode = 'none';
        }
        this.render();
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
            this.newFirma.address = data.address || '';
            this.newFirma.zipcode = data.zipcode || '';
            this.newFirma.city = data.city || '';
        } catch (err) {
            console.warn('CVR-opslag fejlede:', err.message);
        }
        this.cvrLoading = false;
        this.render();
    }

    async saveNew() {
        const kontakt = this.newKontakt;
        if (!kontakt.first_name || !kontakt.first_name.trim()) {
            alert('Fornavn er påkrævet');
            return;
        }

        try {
            let company_id = null;
            let company_name = null;

            if (this.firmaMode === 'existing' && this.selectedFirma) {
                company_id = this.selectedFirma.id;
                company_name = this.selectedFirma.name;
            } else if (this.firmaMode === 'new' && this.newFirma.name && this.newFirma.name.trim()) {
                const compRes = await fetch('/api/companies', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: this.newFirma.name.trim(),
                        cvr: this.newFirma.cvr || null,
                        phone: this.newFirma.phone || null
                    })
                });
                const compData = await compRes.json();
                if (compData.error) throw new Error(compData.error);
                company_id = compData.id;
                company_name = this.newFirma.name.trim();
            }
            // 'none' eller 'privat' → company_id forbliver null

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
                this.renderCreate(el);
                break;
        }
    }

    renderSearch(el) {
        const row = document.createElement('div');
        row.className = 'ks-search-row';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'ks-input';
        input.placeholder = 'Søg på navn, firma eller CVR...';
        input.value = this.searchQuery;
        input.addEventListener('input', (e) => this.scheduleSearch(e.target.value));
        row.appendChild(input);

        const createBtn = document.createElement('button');
        createBtn.type = 'button';
        createBtn.className = 'ks-create-inline-btn';
        createBtn.textContent = '+ Ny kunde';
        createBtn.title = 'Opret ny kunde';
        createBtn.addEventListener('click', () => this.startCreate());
        row.appendChild(createBtn);

        el.appendChild(row);

        if (this.state === 'SEARCHING') {
            const spinner = document.createElement('div');
            spinner.className = 'ks-spinner';
            spinner.textContent = 'Søger...';
            el.appendChild(spinner);
        }

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
                    const r = document.createElement('div');
                    r.className = 'ks-result';
                    r.addEventListener('click', () => this.select(item));

                    if (item.company_name) {
                        const firma = document.createElement('div');
                        firma.className = 'ks-result-firma';
                        firma.textContent = item.company_name;
                        r.appendChild(firma);
                    }

                    const kontakt = document.createElement('div');
                    kontakt.className = 'ks-result-kontakt';
                    const name = `${item.first_name} ${item.last_name || ''}`.trim();
                    const parts = [name];
                    if (item.email) parts.push(item.email);
                    kontakt.textContent = parts.join('  ·  ');
                    r.appendChild(kontakt);

                    dropdown.appendChild(r);
                }
            }

            el.appendChild(dropdown);
        }

        requestAnimationFrame(() => input.focus());
    }

    renderSelected(el) {
        const card = document.createElement('div');
        card.className = 'ks-selected-card';

        const main = document.createElement('div');
        main.className = 'ks-selected-main';

        // Cross-link er kun aktivt i office-zonen (kitchen har ikke CRM-views)
        const isOffice = document.body.classList.contains('zone-office');

        // Person
        const personRow = document.createElement('div');
        personRow.className = 'ks-sel-row';
        personRow.innerHTML = `<span class="ks-sel-icon">👤</span>`;
        const personText = document.createElement('div');
        personText.className = 'ks-sel-text';
        const name = document.createElement('div');
        name.className = 'ks-sel-name';
        name.textContent = this.selected.customer_name || '—';
        if (isOffice && this.selected.customer_id && typeof window.openKunde360 === 'function') {
            name.classList.add('ks-sel-name-link');
            name.title = 'Åbn Kunde 360°';
            name.addEventListener('click', (e) => {
                e.stopPropagation();
                window.openKunde360(this.selected.customer_id);
            });
        }
        personText.appendChild(name);
        const personMeta = [];
        if (this.selected.email) personMeta.push(this.selected.email);
        if (this.selected.phone) personMeta.push(this.selected.phone);
        if (personMeta.length) {
            const meta = document.createElement('div');
            meta.className = 'ks-sel-meta';
            meta.textContent = personMeta.join('  ·  ');
            personText.appendChild(meta);
        }
        personRow.appendChild(personText);
        main.appendChild(personRow);

        // Firma
        if (this.selected.company_name || this.selected.company_id) {
            const compRow = document.createElement('div');
            compRow.className = 'ks-sel-row';
            compRow.innerHTML = `<span class="ks-sel-icon">🏢</span>`;
            const compText = document.createElement('div');
            compText.className = 'ks-sel-text';
            const cname = document.createElement('div');
            cname.className = 'ks-sel-name';
            cname.textContent = this.selected.company_name || '—';
            if (isOffice && this.selected.company_id && typeof window.openFirma360 === 'function') {
                cname.classList.add('ks-sel-name-link');
                cname.title = 'Åbn Firma 360°';
                cname.addEventListener('click', (e) => {
                    e.stopPropagation();
                    window.openFirma360(this.selected.company_id);
                });
            }
            compText.appendChild(cname);
            const compMeta = [];
            if (this.selected.company_cvr) compMeta.push('CVR ' + this.selected.company_cvr);
            if (this.selected.company_city) compMeta.push(this.selected.company_city);
            if (compMeta.length) {
                const meta = document.createElement('div');
                meta.className = 'ks-sel-meta';
                meta.textContent = compMeta.join('  ·  ');
                compText.appendChild(meta);
            }
            compRow.appendChild(compText);
            main.appendChild(compRow);
        } else {
            const compRow = document.createElement('div');
            compRow.className = 'ks-sel-row ks-sel-row-muted';
            compRow.innerHTML = `<span class="ks-sel-icon">👤</span><div class="ks-sel-text"><div class="ks-sel-meta">Privatkunde (intet firma)</div></div>`;
            main.appendChild(compRow);
        }

        card.appendChild(main);

        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'ks-selected-clear';
        clearBtn.textContent = '✕';
        clearBtn.title = 'Skift kunde';
        clearBtn.addEventListener('click', () => this.clear());
        card.appendChild(clearBtn);

        el.appendChild(card);

        // Hvis vi mangler firma-info (CVR/by) men har company_id, hent dem og re-render
        if (this.selected.company_id && (!this.selected.company_cvr || !this.selected.company_city)) {
            this.enrichCompanyInfo();
        }
    }

    async enrichCompanyInfo() {
        if (!this.selected || !this.selected.company_id) return;
        if (this._enrichingCompanyId === this.selected.company_id) return;
        this._enrichingCompanyId = this.selected.company_id;
        try {
            const res = await fetch(`/api/companies/${this.selected.company_id}`);
            if (!res.ok) return;
            const data = await res.json();
            if (!this.selected || this.selected.company_id !== data.id) return;
            this.selected.company_cvr = data.cvr || this.selected.company_cvr || null;
            this.selected.company_city = data.city || this.selected.company_city || null;
            if (this.state === 'SELECTED') this.render();
        } catch (_) {} finally {
            this._enrichingCompanyId = null;
        }
    }

    /* ── CREATE: ét sammenhængende formular ─────────────── */

    renderCreate(el) {
        const form = document.createElement('div');
        form.className = 'ks-form';

        const title = document.createElement('h3');
        title.className = 'ks-form-title';
        title.textContent = 'Ny kunde';
        form.appendChild(title);

        // ── KONTAKT (først — det er kunden) ──
        const kontaktFields = [
            { key: 'first_name', label: 'Fornavn *', autofocus: true },
            { key: 'last_name', label: 'Efternavn' },
            { key: 'email', label: 'Email' },
            { key: 'phone', label: 'Telefon' }
        ];
        for (const f of kontaktFields) {
            form.appendChild(this.createField(f.label, this.newKontakt[f.key] || '', (val) => {
                this.newKontakt[f.key] = val;
            }, { autofocus: f.autofocus, type: f.key === 'email' ? 'email' : 'text' }));
        }

        // ── DIVIDER ──
        const divider = document.createElement('div');
        divider.className = 'ks-section-divider';
        divider.innerHTML = '<span>Firma</span>';
        form.appendChild(divider);

        // ── FIRMA-SEKTION ──
        form.appendChild(this.renderFirmaSection());

        // ── KNAPPER ──
        const actions = document.createElement('div');
        actions.className = 'ks-form-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'ks-btn-secondary';
        cancelBtn.textContent = 'Annuller';
        cancelBtn.addEventListener('click', () => this.cancelCreate());
        actions.appendChild(cancelBtn);

        const saveBtn = document.createElement('button');
        saveBtn.className = 'ks-btn-primary';
        saveBtn.textContent = 'Opret kunde';
        saveBtn.addEventListener('click', () => this.saveNew());
        actions.appendChild(saveBtn);

        form.appendChild(actions);
        el.appendChild(form);
    }

    renderFirmaSection() {
        const wrap = document.createElement('div');
        wrap.className = 'ks-firma-section';

        // Privatkunde-toggle (altid tilgængelig)
        const privatRow = document.createElement('div');
        privatRow.className = 'ks-form-field ks-privat-row';
        const privatLabel = document.createElement('label');
        privatLabel.className = 'ks-privat-label';
        const privatCheck = document.createElement('input');
        privatCheck.type = 'checkbox';
        privatCheck.checked = this.firmaMode === 'privat';
        privatCheck.addEventListener('change', (e) => this.setPrivat(e.target.checked));
        privatLabel.appendChild(privatCheck);
        privatLabel.appendChild(document.createTextNode(' Privatkunde (intet firma)'));
        privatRow.appendChild(privatLabel);
        wrap.appendChild(privatRow);

        if (this.firmaMode === 'privat') {
            return wrap;
        }

        if (this.firmaMode === 'existing' && this.selectedFirma) {
            wrap.appendChild(this.renderFirmaPill(this.selectedFirma, 'existing'));
            return wrap;
        }

        if (this.firmaMode === 'new') {
            wrap.appendChild(this.renderNewFirmaForm());
            return wrap;
        }

        // Default: søg-felt + altid synlig "Opret nyt"-knap
        const searchWrap = document.createElement('div');
        searchWrap.className = 'ks-form-field ks-firma-search-wrap';

        const lbl = document.createElement('label');
        lbl.textContent = 'Tilknyt firma';
        searchWrap.appendChild(lbl);

        const searchRow = document.createElement('div');
        searchRow.className = 'ks-firma-search-row';

        const inputWrap = document.createElement('div');
        inputWrap.className = 'ks-firma-input-wrap';

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Søg eksisterende firma...';
        input.value = this.firmaSearchQuery;
        input.className = 'ks-firma-search-input';
        input.addEventListener('input', (e) => this.scheduleFirmaSearch(e.target.value));
        input.addEventListener('focus', () => {
            if (this.firmaSearchQuery.length >= 2) {
                this.firmaShowResults = true;
                this.updateFirmaDropdown();
            }
        });
        inputWrap.appendChild(input);

        // Dropdown-container (genbruges ved updateFirmaDropdown)
        const dropdown = document.createElement('div');
        dropdown.className = 'ks-firma-dropdown';
        dropdown.dataset.firmaDropdown = '1';
        if (!this.firmaShowResults) dropdown.style.display = 'none';
        inputWrap.appendChild(dropdown);

        searchRow.appendChild(inputWrap);

        const newBtn = document.createElement('button');
        newBtn.type = 'button';
        newBtn.className = 'ks-create-inline-btn';
        newBtn.textContent = '+ Nyt firma';
        newBtn.title = 'Opret nyt firma';
        newBtn.addEventListener('click', () => this.startNewFirma(this.firmaSearchQuery));
        searchRow.appendChild(newBtn);

        searchWrap.appendChild(searchRow);
        wrap.appendChild(searchWrap);

        // Initial dropdown content
        this.fillFirmaDropdown(dropdown);

        return wrap;
    }

    fillFirmaDropdown(dropdown) {
        dropdown.innerHTML = '';

        if (this.firmaSearching) {
            const spinner = document.createElement('div');
            spinner.className = 'ks-spinner';
            spinner.textContent = 'Søger...';
            dropdown.appendChild(spinner);
            return;
        }

        if (this.firmaSearchQuery.length >= 2) {
            if (this.firmaResults.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'ks-empty';
                empty.textContent = 'Ingen firmaer fundet';
                dropdown.appendChild(empty);
            } else {
                for (const co of this.firmaResults) {
                    const row = document.createElement('div');
                    row.className = 'ks-result';
                    row.addEventListener('click', () => this.pickExistingFirma(co));

                    const main = document.createElement('div');
                    main.className = 'ks-result-firma';
                    main.textContent = co.name;
                    row.appendChild(main);

                    const sub = document.createElement('div');
                    sub.className = 'ks-result-kontakt';
                    const subParts = [];
                    if (co.cvr) subParts.push('CVR ' + co.cvr);
                    if (co.email) subParts.push(co.email);
                    sub.textContent = subParts.join('  ·  ');
                    if (subParts.length) row.appendChild(sub);

                    dropdown.appendChild(row);
                }
            }
        }

        const createBtn = document.createElement('div');
        createBtn.className = 'ks-create-btn';
        createBtn.textContent = this.firmaSearchQuery
            ? `+ Opret nyt firma "${this.firmaSearchQuery}"`
            : '+ Opret nyt firma';
        createBtn.addEventListener('click', () => this.startNewFirma(this.firmaSearchQuery));
        dropdown.appendChild(createBtn);
    }

    updateFirmaDropdown() {
        const dropdown = this.container.querySelector('[data-firma-dropdown="1"]');
        if (!dropdown) return;
        dropdown.style.display = this.firmaShowResults ? '' : 'none';
        this.fillFirmaDropdown(dropdown);
    }

    renderFirmaPill(company, mode) {
        const pill = document.createElement('div');
        pill.className = 'ks-firma-pill ks-firma-pill-' + mode;

        const text = document.createElement('div');
        text.className = 'ks-firma-pill-text';
        const name = document.createElement('strong');
        name.textContent = company.name;
        text.appendChild(name);
        const subParts = [];
        if (company.cvr) subParts.push('CVR ' + company.cvr);
        if (mode === 'existing') subParts.push('eksisterende firma');
        if (subParts.length) {
            const sub = document.createElement('div');
            sub.className = 'ks-firma-pill-sub';
            sub.textContent = subParts.join('  ·  ');
            text.appendChild(sub);
        }
        pill.appendChild(text);

        const clearBtn = document.createElement('button');
        clearBtn.className = 'ks-selected-clear';
        clearBtn.textContent = '✕';
        clearBtn.title = 'Fjern firma';
        clearBtn.addEventListener('click', () => this.clearFirmaSelection());
        pill.appendChild(clearBtn);

        return pill;
    }

    renderNewFirmaForm() {
        const wrap = document.createElement('div');
        wrap.className = 'ks-new-firma-form';

        const header = document.createElement('div');
        header.className = 'ks-new-firma-header';
        header.innerHTML = '<span>Nyt firma</span>';
        const cancelLink = document.createElement('button');
        cancelLink.type = 'button';
        cancelLink.className = 'ks-link-btn';
        cancelLink.textContent = 'Annuller';
        cancelLink.addEventListener('click', () => this.clearFirmaSelection());
        header.appendChild(cancelLink);
        wrap.appendChild(header);

        // CVR-række med opslag
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
        cvrBtn.type = 'button';
        cvrBtn.className = 'ks-cvr-btn';
        cvrBtn.textContent = this.cvrLoading ? '...' : 'Slå op';
        cvrBtn.disabled = this.cvrLoading;
        cvrBtn.addEventListener('click', () => this.cvrLookup(this.newFirma.cvr || ''));
        cvrInner.appendChild(cvrBtn);

        cvrRow.appendChild(cvrInner);
        wrap.appendChild(cvrRow);

        const fields = [
            { key: 'name', label: 'Firmanavn *' },
            { key: 'phone', label: 'Telefon' }
        ];
        for (const f of fields) {
            wrap.appendChild(this.createField(f.label, this.newFirma[f.key] || '', (val) => {
                this.newFirma[f.key] = val;
            }));
        }

        return wrap;
    }

    /* ══════════════════════════════════════════════════════
       HELPERS
       ══════════════════════════════════════════════════════ */

    createField(label, value, onChange, opts = {}) {
        const wrap = document.createElement('div');
        wrap.className = 'ks-form-field';

        const lbl = document.createElement('label');
        lbl.textContent = label;
        wrap.appendChild(lbl);

        const input = document.createElement('input');
        input.type = opts.type || 'text';
        input.value = value;
        input.addEventListener('input', (e) => onChange(e.target.value));
        if (opts.autofocus) {
            requestAnimationFrame(() => input.focus());
        }
        wrap.appendChild(input);

        return wrap;
    }

    /** Programmatisk: sæt valgt kunde (til drawer/edit) */
    setSelected(data) {
        if (!data) { this.clear(); return; }
        this.selected = data;
        this.setState('SELECTED');
        // Kald IKKE onSelect — det er en ekstern sæt-operation
    }

    /** Hent den valgte kundes data */
    getSelected() {
        return this.selected;
    }
}

// Global alias for non-module scripts
if (typeof window !== 'undefined') window.KundeSoeg = KundeSoeg;
