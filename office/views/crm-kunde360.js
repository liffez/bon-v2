/**
 * office/views/crm-kunde360.js
 * ════════════════════════════════════════════════════════════
 * Kunde 360° profil — info, sentiment, ordrer, aktiviteter, tilbud, mail
 * ════════════════════════════════════════════════════════════
 */

let _k3Container = null;
let _k3Opts = {};
let _k3Active = false;
let _k3CustomerId = null;
let _k3Data = null;
let _k3Tab = 'orders';
let _k3Purposes = null;

function initCrmKunde360(containerEl, opts) {
    _k3Container = containerEl;
    _k3Opts = opts || {};
    _k3Active = true;

    const params = new URLSearchParams(window.location.search);
    _k3CustomerId = params.get('customer') ? parseInt(params.get('customer')) : null;
    _k3CompanyFilter = null;
    const companyId = params.get('company') ? parseInt(params.get('company')) : null;
    if (companyId) {
        _k3CompanyFilter = { id: companyId, name: params.get('company_name') || null };
    }

    // Hent aktivitetsformål (én gang)
    if (!_k3Purposes) {
        fetchActivityPurposes().then(p => { _k3Purposes = p; }).catch(() => {});
    }

    if (_k3CustomerId) {
        _k3RenderShell();
        _k3LoadData();
    } else {
        _k3RenderSearch();
    }
}

function cleanupCrmKunde360() {
    _k3Active = false;
    _k3Container = null;
    _k3Data = null;
}

// ─── Search (no customer selected) ──────────────────────────

let _k3CreateMode = false;

// Hentes fra URL ved init og bruges til at filtrere kundesøgning til ét firma.
let _k3CompanyFilter = null;

function _k3RenderSearch() {
    const topTitle = document.getElementById('office-topbar-title');
    if (topTitle) topTitle.textContent = 'Kunder';
    _k3CreateMode = false;

    _k3Container.innerHTML = `
        <style>
            .k3-search-wrap { max-width: 640px; margin: 40px auto; }
            .k3-search-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
            .k3-new-btn {
                padding: 8px 18px; border-radius: 8px; border: none;
                background: var(--brand-primary, #8e631f); color: white;
                font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit;
            }
            .k3-new-btn:hover { filter: brightness(1.1); }
            .k3-search-input {
                width: 100%; padding: 12px 16px; font-size: 15px;
                border: 2px solid var(--color-border, #d7d1ca); border-radius: 10px;
                outline: none; background: var(--color-surface, #fff);
                font-family: var(--font-body, 'DM Sans', system-ui, sans-serif);
            }
            .k3-search-input:focus { border-color: var(--brand-primary, #8e631f); }
            .k3-search-results { margin-top: 8px; }
            .k3-search-row {
                display: flex; justify-content: space-between; align-items: center;
                padding: 12px 14px; border-bottom: 1px solid var(--color-border, #eee);
                cursor: pointer; border-radius: 6px; transition: background .1s;
            }
            .k3-search-row:hover { background: var(--brand-primary-light, #f1e6b2); }
            .k3-search-name { font-weight: 600; font-size: 14px; }
            .k3-search-company { font-size: 13px; color: var(--color-text-dim, #888); margin-top: 2px; }
            .k3-search-stats { font-size: 13px; color: var(--color-text-dim, #888); text-align: right; }
            .k3-stage-filters { display: flex; gap: 6px; margin: 16px 0; flex-wrap: wrap; }
            .k3-stage-btn {
                padding: 5px 14px; border-radius: 16px; border: 1px solid var(--color-border, #ddd);
                background: var(--color-surface, #fff); font-size: 13px; cursor: pointer;
                font-family: inherit; transition: all .12s;
            }
            .k3-stage-btn:hover { background: var(--color-background, #f5f4f2); }
            .k3-stage-btn.active { background: var(--brand-primary, #8e631f); color: white; border-color: transparent; }

            /* Create form */
            .k3-create { background: var(--color-surface); border-radius: 12px; padding: 24px; box-shadow: 0 1px 4px rgba(0,0,0,0.07); }
            .k3-create-title {
                font-family: var(--font-heading, 'Playfair Display', Georgia, serif);
                font-size: 20px; font-weight: 700; margin-bottom: 20px;
            }
            .k3-create-section {
                font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px;
                color: var(--color-text-dim); margin: 20px 0 10px; padding-bottom: 6px;
                border-bottom: 1px solid var(--color-border);
            }
            .k3-create-section:first-of-type { margin-top: 0; }
            .k3-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
            .k3-form-full { grid-column: 1 / -1; }
            .k3-form-group { display: flex; flex-direction: column; gap: 3px; }
            .k3-form-label { font-size: 11px; font-weight: 600; color: var(--color-text-dim); }
            .k3-form-input {
                padding: 8px 12px; border-radius: 6px; border: 1px solid var(--color-border);
                font-size: 14px; font-family: inherit; background: var(--color-surface);
            }
            .k3-form-input:focus { border-color: var(--brand-primary); outline: none; }
            .k3-form-input::placeholder { color: var(--color-text-dim); opacity: 0.5; }
            .k3-form-check { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; margin: 8px 0; }
            .k3-form-check input { width: 16px; height: 16px; accent-color: var(--brand-primary); }

            /* CVR lookup */
            .k3-cvr-row { display: flex; gap: 8px; align-items: flex-end; }
            .k3-cvr-row .k3-form-group { flex: 1; }
            .k3-cvr-btn {
                padding: 8px 14px; border-radius: 6px; border: 1px solid var(--color-border);
                background: var(--color-surface); font-size: 13px; font-weight: 600; cursor: pointer;
                font-family: inherit; white-space: nowrap; height: 38px;
            }
            .k3-cvr-btn:hover { background: var(--brand-primary-light); }
            .k3-cvr-results {
                margin-top: 6px; border: 1px solid var(--color-border); border-radius: 8px;
                max-height: 200px; overflow-y: auto; display: none;
            }
            .k3-cvr-item {
                padding: 8px 12px; cursor: pointer; border-bottom: 1px solid var(--color-border);
                font-size: 13px;
            }
            .k3-cvr-item:last-child { border-bottom: none; }
            .k3-cvr-item:hover { background: var(--brand-primary-light); }
            .k3-cvr-item-name { font-weight: 600; }
            .k3-cvr-item-detail { font-size: 11px; color: var(--color-text-dim); }
            .k3-cvr-selected {
                padding: 10px 12px; border-radius: 8px; background: var(--brand-primary-light);
                display: flex; justify-content: space-between; align-items: center;
                margin-top: 8px; font-size: 13px;
            }
            .k3-cvr-selected-name { font-weight: 600; }
            .k3-cvr-selected-clear { cursor: pointer; font-size: 16px; color: var(--color-text-dim); }

            /* DAWA */
            .k3-dawa-wrap { position: relative; }
            .k3-dawa-results {
                position: absolute; top: 100%; left: 0; right: 0; z-index: 50;
                background: var(--color-surface); border: 1px solid var(--color-border);
                border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);
                max-height: 200px; overflow-y: auto; display: none;
            }
            .k3-dawa-item { padding: 8px 12px; cursor: pointer; font-size: 13px; }
            .k3-dawa-item:hover { background: var(--brand-primary-light); }

            /* Actions */
            .k3-create-actions { display: flex; gap: 10px; margin-top: 20px; justify-content: flex-end; }
            .k3-create-cancel {
                padding: 8px 18px; border-radius: 8px; border: 1px solid var(--color-border);
                background: var(--color-surface); font-size: 14px; cursor: pointer; font-family: inherit;
            }
            .k3-create-save {
                padding: 8px 24px; border-radius: 8px; border: none;
                background: var(--brand-primary); color: white;
                font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit;
            }
            .k3-create-save:hover { filter: brightness(1.1); }
            .k3-create-save:disabled { opacity: 0.5; cursor: default; filter: none; }
        </style>
        <div class="k3-search-wrap">
            <div class="k3-search-header">
                <div id="k3CompanyPill"></div>
                <button class="k3-new-btn" id="k3NewBtn">+ Ny kunde</button>
            </div>
            <div id="k3SearchArea">
                <input type="text" class="k3-search-input" placeholder="Søg kunde, firma, email, telefon..." id="k3SearchInput" autofocus>
                <div class="k3-stage-filters" id="k3StageFilters">
                    <button class="k3-stage-btn active" data-stage="all">Alle</button>
                    <button class="k3-stage-btn" data-stage="vip">VIP</button>
                    <button class="k3-stage-btn" data-stage="active">Aktive</button>
                    <button class="k3-stage-btn" data-stage="dormant">Sovende</button>
                    <button class="k3-stage-btn" data-stage="lead">Leads</button>
                </div>
                <div class="k3-search-results" id="k3SearchResults"></div>
            </div>
            <div id="k3CreateArea" style="display:none;"></div>
        </div>
    `;

    // Vis "filtreret på firma X"-pill med ryd-knap når URL har ?company=
    if (_k3CompanyFilter?.id) {
        const pill = document.getElementById('k3CompanyPill');
        if (pill) {
            pill.innerHTML = `
                <span style="display:inline-flex;align-items:center;gap:8px;padding:6px 12px;background:var(--brand-primary-light,#f1e6b2);border-radius:18px;font-size:13px;font-weight:600;color:var(--brand-primary,#8e631f);">
                    <span>🏢 ${_k3CompanyFilter.name || 'Firma #' + _k3CompanyFilter.id}</span>
                    <button id="k3ClearCompany" style="background:none;border:none;color:inherit;cursor:pointer;font-size:16px;padding:0;line-height:1;" title="Fjern firma-filter">×</button>
                </span>`;
            document.getElementById('k3ClearCompany')?.addEventListener('click', () => {
                _k3CompanyFilter = null;
                pill.innerHTML = '';
                // Ryd company-params i URL'en uden at oprette ny history-entry
                // — så browser-back fortsat fører tilbage til forrige view.
                const url = new URL(window.location);
                url.searchParams.delete('company');
                url.searchParams.delete('company_name');
                history.replaceState({}, '', url);
                _k3DoSearch(document.getElementById('k3SearchInput')?.value || '', 'all');
            });
        }
    }

    // "+ Ny kunde" button
    document.getElementById('k3NewBtn').addEventListener('click', () => {
        if (_k3CreateMode) {
            _k3CreateMode = false;
            document.getElementById('k3SearchArea').style.display = '';
            document.getElementById('k3CreateArea').style.display = 'none';
            document.getElementById('k3NewBtn').textContent = '+ Ny kunde';
            document.getElementById('k3SearchInput').focus();
        } else {
            _k3CreateMode = true;
            document.getElementById('k3SearchArea').style.display = 'none';
            document.getElementById('k3CreateArea').style.display = '';
            document.getElementById('k3NewBtn').textContent = '← Tilbage til søg';
            _k3RenderCreateForm();
        }
    });

    let _debounce = null;
    let _stage = 'all';

    const input = document.getElementById('k3SearchInput');
    input.addEventListener('input', () => {
        clearTimeout(_debounce);
        _debounce = setTimeout(() => _k3DoSearch(input.value, _stage), 250);
    });

    document.getElementById('k3StageFilters').addEventListener('click', (e) => {
        const btn = e.target.closest('.k3-stage-btn');
        if (!btn) return;
        _stage = btn.dataset.stage;
        document.querySelectorAll('.k3-stage-btn').forEach(b => b.classList.toggle('active', b === btn));
        _k3DoSearch(input.value, _stage);
    });

    _k3DoSearch('', 'all');
}

// ─── Create customer form ───────────────────────────────────

let _k3CvrData = null; // selected company from CVR

function _k3RenderCreateForm() {
    const area = document.getElementById('k3CreateArea');
    if (!area) return;
    _k3CvrData = null;

    area.innerHTML = `
        <div class="k3-create">
            <div class="k3-create-title">Opret ny kunde</div>

            <label class="k3-form-check">
                <input type="checkbox" id="k3Privat"> Privatkunde (intet firma)
            </label>

            <div id="k3FirmaSection">
                <div class="k3-create-section">Firma</div>
                <div class="k3-cvr-row">
                    <div class="k3-form-group">
                        <label class="k3-form-label">Søg firma (navn eller CVR)</label>
                        <input type="text" class="k3-form-input" id="k3CvrSearch" placeholder="Fx Novo Nordisk eller 12345678">
                    </div>
                    <button class="k3-cvr-btn" id="k3CvrBtn">Slå op</button>
                </div>
                <div class="k3-cvr-results" id="k3CvrResults"></div>
                <div id="k3CvrSelected" style="display:none;"></div>
                <div class="k3-form-grid" style="margin-top:10px;">
                    <div class="k3-form-group">
                        <label class="k3-form-label">Firmanavn</label>
                        <input type="text" class="k3-form-input" id="k3FirmaNavn" placeholder="Firmanavn">
                    </div>
                    <div class="k3-form-group">
                        <label class="k3-form-label">CVR</label>
                        <input type="text" class="k3-form-input" id="k3FirmaCvr" placeholder="12345678">
                    </div>
                    <div class="k3-form-group">
                        <label class="k3-form-label">Firma email</label>
                        <input type="email" class="k3-form-input" id="k3FirmaEmail" placeholder="info@firma.dk">
                    </div>
                    <div class="k3-form-group">
                        <label class="k3-form-label">Firma telefon</label>
                        <input type="tel" class="k3-form-input" id="k3FirmaTlf" placeholder="12 34 56 78">
                    </div>
                    <div class="k3-form-group">
                        <label class="k3-form-label">EAN</label>
                        <input type="text" class="k3-form-input" id="k3FirmaEan" placeholder="13 cifre (valgfrit)">
                    </div>
                </div>
            </div>

            <div class="k3-create-section">Kontaktperson</div>
            <div class="k3-form-grid">
                <div class="k3-form-group">
                    <label class="k3-form-label">Fornavn *</label>
                    <input type="text" class="k3-form-input" id="k3KontaktFornavn" placeholder="Fornavn" autofocus>
                </div>
                <div class="k3-form-group">
                    <label class="k3-form-label">Efternavn</label>
                    <input type="text" class="k3-form-input" id="k3KontaktEfternavn" placeholder="Efternavn">
                </div>
                <div class="k3-form-group">
                    <label class="k3-form-label">Email</label>
                    <input type="email" class="k3-form-input" id="k3KontaktEmail" placeholder="email@firma.dk">
                </div>
                <div class="k3-form-group">
                    <label class="k3-form-label">Telefon</label>
                    <input type="tel" class="k3-form-input" id="k3KontaktTlf" placeholder="12 34 56 78">
                </div>
            </div>

            <div class="k3-create-section">Adresse (valgfrit)</div>
            <div class="k3-dawa-wrap">
                <input type="text" class="k3-form-input" id="k3DawaInput" placeholder="Søg adresse..." style="width:100%;">
                <div class="k3-dawa-results" id="k3DawaResults"></div>
            </div>
            <div id="k3DawaSelected" style="display:none;margin-top:8px;"></div>

            <div class="k3-create-actions">
                <button class="k3-create-cancel" onclick="_k3CancelCreate()">Annuller</button>
                <button class="k3-create-save" id="k3SaveBtn" onclick="_k3SaveNewCustomer()">Opret kunde</button>
            </div>
        </div>
    `;

    // Privat checkbox — hide firma section
    document.getElementById('k3Privat').addEventListener('change', (e) => {
        document.getElementById('k3FirmaSection').style.display = e.target.checked ? 'none' : '';
    });

    // CVR search
    _k3BindCvrSearch();

    // DAWA autocomplete
    _k3BindDawa();
}

function _k3BindCvrSearch() {
    const input = document.getElementById('k3CvrSearch');
    const btn = document.getElementById('k3CvrBtn');
    const resultsEl = document.getElementById('k3CvrResults');

    async function doLookup() {
        const q = (input.value || '').trim();
        if (q.length < 2) return;

        try {
            let results;
            if (/^\d{8}$/.test(q.replace(/\s/g, ''))) {
                // CVR number lookup
                const r = await apiFetch('/cvr/' + q.replace(/\s/g, ''));
                results = r ? [r] : [];
            } else {
                // Name search
                results = await apiFetch('/cvr/search?q=' + encodeURIComponent(q));
            }

            if (!results.length) {
                resultsEl.innerHTML = '<div class="k3-cvr-item" style="color:var(--color-text-dim);">Ingen resultater</div>';
                resultsEl.style.display = 'block';
                return;
            }

            resultsEl.innerHTML = results.slice(0, 8).map(r =>
                '<div class="k3-cvr-item" data-cvr=\'' + JSON.stringify(r).replace(/'/g, '&#39;') + '\'>' +
                    '<div class="k3-cvr-item-name">' + (r.name || '') + '</div>' +
                    '<div class="k3-cvr-item-detail">CVR: ' + (r.cvr || '—') + ' · ' + (r.address || '') + ' ' + (r.zipcode || '') + ' ' + (r.city || '') + '</div>' +
                '</div>'
            ).join('');
            resultsEl.style.display = 'block';

            resultsEl.querySelectorAll('.k3-cvr-item[data-cvr]').forEach(item => {
                item.addEventListener('click', () => {
                    const data = JSON.parse(item.dataset.cvr);
                    _k3SelectCvr(data);
                });
            });
        } catch (err) {
            console.error('[k3] CVR lookup:', err);
            resultsEl.innerHTML = '<div class="k3-cvr-item" style="color:var(--color-sentiment-neg);">Fejl: ' + err.message + '</div>';
            resultsEl.style.display = 'block';
        }
    }

    btn.addEventListener('click', doLookup);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doLookup(); } });
}

function _k3SelectCvr(data) {
    _k3CvrData = data;
    document.getElementById('k3CvrResults').style.display = 'none';

    // Fill firma fields
    if (data.name) document.getElementById('k3FirmaNavn').value = data.name;
    if (data.cvr) document.getElementById('k3FirmaCvr').value = data.cvr;
    if (data.email) document.getElementById('k3FirmaEmail').value = data.email;
    if (data.phone) document.getElementById('k3FirmaTlf').value = data.phone;

    // Show selected badge
    const sel = document.getElementById('k3CvrSelected');
    sel.style.display = '';
    sel.innerHTML = '<div class="k3-cvr-selected">' +
        '<div><span class="k3-cvr-selected-name">' + data.name + '</span>' +
        '<span style="margin-left:8px;font-size:11px;color:var(--color-text-dim);">CVR: ' + (data.cvr || '') + '</span></div>' +
        '<span class="k3-cvr-selected-clear" onclick="_k3ClearCvr()">✕</span>' +
    '</div>';

    // If address from CVR, pre-fill DAWA
    if (data.address) {
        const addrStr = (data.address || '') + ' ' + (data.zipcode || '') + ' ' + (data.city || '');
        document.getElementById('k3DawaInput').value = addrStr.trim();
    }
}

function _k3ClearCvr() {
    _k3CvrData = null;
    document.getElementById('k3CvrSelected').style.display = 'none';
    document.getElementById('k3CvrSelected').innerHTML = '';
    document.getElementById('k3CvrSearch').value = '';
}

// ─── DAWA autocomplete ──────────────────────────────────────

let _k3DawaAddress = null;

function _k3BindDawa() {
    const input = document.getElementById('k3DawaInput');
    const resultsEl = document.getElementById('k3DawaResults');
    let timer = null;
    _k3DawaAddress = null;

    input.addEventListener('input', () => {
        clearTimeout(timer);
        const q = input.value.trim();
        if (q.length < 3) { resultsEl.style.display = 'none'; return; }

        timer = setTimeout(async () => {
            try {
                const resp = await fetch('https://api.dataforsyningen.dk/adresser/autocomplete?q=' + encodeURIComponent(q) + '&per_side=5');
                const data = await resp.json();
                if (!data.length) { resultsEl.style.display = 'none'; return; }
                resultsEl.innerHTML = data.map(item =>
                    '<div class="k3-dawa-item">' + item.tekst + '</div>'
                ).join('');
                resultsEl.style.display = 'block';

                resultsEl.querySelectorAll('.k3-dawa-item').forEach((el, i) => {
                    el.addEventListener('click', () => _k3SelectDawa(data[i]));
                });
            } catch (err) {
                console.error('[k3] DAWA:', err);
            }
        }, 300);
    });

    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !resultsEl.contains(e.target)) {
            resultsEl.style.display = 'none';
        }
    });
}

async function _k3SelectDawa(item) {
    document.getElementById('k3DawaResults').style.display = 'none';
    document.getElementById('k3DawaInput').value = item.tekst;

    try {
        const resp = await fetch(item.adresse?.href || 'https://api.dataforsyningen.dk/adresser/' + item.adresse?.id);
        const addr = await resp.json();
        _k3DawaAddress = {
            street_name: addr.vejnavn || '',
            street_nr: addr.husnr || '',
            postal_code: addr.postnr || '',
            city: addr.postnrnavn || '',
            lat: addr.adgangsadresse?.adgangspunkt?.koordinater?.[1] || null,
            lon: addr.adgangsadresse?.adgangspunkt?.koordinater?.[0] || null,
            label: item.tekst,
        };

        // Show selected
        const sel = document.getElementById('k3DawaSelected');
        sel.style.display = '';
        sel.innerHTML = '<div class="k3-cvr-selected">' +
            '<span>✓ ' + item.tekst + '</span>' +
            '<span class="k3-cvr-selected-clear" onclick="_k3ClearDawa()">✕</span>' +
        '</div>';
        document.getElementById('k3DawaInput').style.display = 'none';
    } catch (err) {
        console.error('[k3] DAWA select:', err);
    }
}

function _k3ClearDawa() {
    _k3DawaAddress = null;
    document.getElementById('k3DawaSelected').style.display = 'none';
    document.getElementById('k3DawaInput').style.display = '';
    document.getElementById('k3DawaInput').value = '';
}

// ─── Save new customer ──────────────────────────────────────

async function _k3SaveNewCustomer() {
    const isPrivat = document.getElementById('k3Privat').checked;
    const firstName = document.getElementById('k3KontaktFornavn').value.trim();
    const lastName = document.getElementById('k3KontaktEfternavn').value.trim();
    const email = document.getElementById('k3KontaktEmail').value.trim();
    const phone = document.getElementById('k3KontaktTlf').value.trim();

    if (!firstName) { alert('Fornavn er påkrævet'); document.getElementById('k3KontaktFornavn').focus(); return; }

    const saveBtn = document.getElementById('k3SaveBtn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Opretter...';

    try {
        let companyId = null;

        // Create company if not privat
        if (!isPrivat) {
            const firmaName = document.getElementById('k3FirmaNavn').value.trim();
            if (firmaName) {
                const companyResult = await apiFetch('/companies', {
                    method: 'POST',
                    body: JSON.stringify({
                        name: firmaName,
                        cvr: document.getElementById('k3FirmaCvr').value.trim() || null,
                        ean: document.getElementById('k3FirmaEan').value.trim() || null,
                        email: document.getElementById('k3FirmaEmail').value.trim() || null,
                        phone: document.getElementById('k3FirmaTlf').value.trim() || null,
                    }),
                });
                companyId = companyResult.id;
            }
        }

        // Create customer
        const customerResult = await apiFetch('/customers', {
            method: 'POST',
            body: JSON.stringify({
                first_name: firstName,
                last_name: lastName || null,
                email: email || null,
                phone: phone || null,
                company_id: companyId,
            }),
        });

        // Navigate to new customer profile
        _k3Navigate(customerResult.id);
    } catch (err) {
        console.error('[k3] Save error:', err);
        alert('Fejl ved oprettelse: ' + err.message);
        saveBtn.disabled = false;
        saveBtn.textContent = 'Opret kunde';
    }
}

function _k3CancelCreate() {
    _k3CreateMode = false;
    document.getElementById('k3SearchArea').style.display = '';
    document.getElementById('k3CreateArea').style.display = 'none';
    document.getElementById('k3NewBtn').textContent = '+ Ny kunde';
}

async function _k3DoSearch(q, stage) {
    try {
        const params = {};
        if (q) params.q = q;
        if (stage && stage !== 'all') params.stage = stage;
        if (_k3CompanyFilter?.id) params.company_id = _k3CompanyFilter.id;
        params.limit = 30;
        const rows = await fetchCrmCustomers(params);
        _k3RenderSearchResults(rows);
    } catch (err) {
        console.error('[k3] Search error:', err);
    }
}

function _k3RenderSearchResults(rows) {
    const el = document.getElementById('k3SearchResults');
    if (!el) return;

    if (!rows.length) {
        el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--color-text-dim);">Ingen kunder fundet</div>';
        return;
    }

    el.innerHTML = rows.map(r => {
        const stageBadge = r.stage ? '<span style="margin-left:6px;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700;' +
            (r.stage === 'vip' ? 'background:#f5f0e0;color:#8e631f' :
             r.stage === 'active' ? 'background:#e8f2dc;color:#3d7a0a' :
             r.stage === 'dormant' ? 'background:#f0eded;color:#888' :
             'background:#e0ecf5;color:#2a6fb0') + ';">' + r.stage.toUpperCase() + '</span>' : '';
        return '<div class="k3-search-row" onclick="_k3Navigate(' + r.id + ')">' +
            '<div><span class="k3-search-name">' + r.name + stageBadge + '</span>' +
            (r.company_name ? '<div class="k3-search-company">' + r.company_name + '</div>' : '') + '</div>' +
            '<div class="k3-search-stats">' + (r.total_orders || 0) + ' ordrer · ' +
            Math.round(r.total_revenue || 0).toLocaleString('da-DK') + ' kr</div>' +
        '</div>';
    }).join('');
}

function _k3Navigate(customerId) {
    _k3CustomerId = customerId;
    const url = new URL(window.location);
    url.searchParams.set('customer', customerId);
    history.replaceState({}, '', url);
    _k3RenderShell();
    _k3LoadData();
}

// ─── Profile Shell ──────────────────────────────────────────

function _k3RenderShell() {
    const topTitle = document.getElementById('office-topbar-title');
    if (topTitle) topTitle.textContent = 'Kunde 360°';

    _k3Container.innerHTML = `
        <style>
            .k3-layout { display: grid; grid-template-columns: 300px 1fr; gap: 12px; height: 100%; }
            @media (max-width: 900px) { .k3-layout { grid-template-columns: 1fr; } }

            .k3-left {
                background: var(--color-surface, #fff); border-radius: 10px;
                padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.07);
                overflow-y: auto;
            }
            .k3-right { overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }

            .k3-back { font-size: 13px; color: var(--color-text-dim, #888); cursor: pointer; margin-bottom: 14px; }
            .k3-back:hover { color: var(--brand-primary); }

            /* Avatar tile */
            .k3-avatar-row { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
            .k3-avatar {
                width: 52px; height: 52px; border-radius: 12px;
                background: linear-gradient(135deg, #C8962A 0%, #8e631f 100%);
                display: flex; align-items: center; justify-content: center;
                font-family: var(--font-heading, 'Playfair Display', Georgia, serif);
                font-size: 22px; font-weight: 700; color: #fff;
            }
            .k3-name-block { flex: 1; min-width: 0; }
            .k3-name {
                font-family: var(--font-heading, 'Playfair Display', Georgia, serif);
                font-size: 19px; font-weight: 700; line-height: 1.2;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            }
            .k3-company { font-size: 13px; color: var(--color-text-dim, #888); margin-top: 2px; }
            .k3-company-link { color: var(--brand-primary, #8e631f); text-decoration: none; cursor: pointer; }
            .k3-company-link:hover { text-decoration: underline; }
            .k3-stage-badge {
                display: inline-block; padding: 3px 12px; border-radius: 12px;
                font-size: 11px; font-weight: 700; margin-top: 4px;
            }
            .k3-stage-vip { background: #f5f0e0; color: #8e631f; }
            .k3-stage-active { background: #e8f2dc; color: #3d7a0a; }
            .k3-stage-dormant { background: #f0eded; color: #888; }
            .k3-stage-lead { background: #e0ecf5; color: #2a6fb0; }

            /* Contact info */
            .k3-contact-section { margin: 14px 0; padding: 12px 0; border-top: 1px solid var(--color-border, #eee); }
            .k3-contact-row { font-size: 13px; padding: 5px 0; display: flex; align-items: center; gap: 8px; }
            .k3-contact-row a { color: var(--brand-primary); text-decoration: none; }
            .k3-contact-row a:hover { text-decoration: underline; }
            .k3-contact-icon { width: 20px; text-align: center; font-size: 14px; }

            /* Sentiment trendline */
            .k3-sentiment-section {
                margin: 12px 0; padding: 14px; border-radius: 10px;
                background: var(--color-background, #f5f4f2);
            }
            .k3-sent-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--color-text-dim); margin-bottom: 10px; }
            .k3-sent-dots {
                display: flex; align-items: center; justify-content: center;
                gap: 4px; margin-bottom: 10px;
            }
            .k3-sent-dot {
                width: 28px; height: 28px; border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                font-size: 14px;
            }
            .k3-sent-dot.pos { background: var(--color-sentiment-pos-bg, #E6F7F0); }
            .k3-sent-dot.neu { background: var(--color-sentiment-neu-bg, #FBF3E2); }
            .k3-sent-dot.neg { background: var(--color-sentiment-neg-bg, #FBE9E9); }
            .k3-sent-dot.empty { background: transparent; border: 2px dashed var(--color-border, #d7d1ca); }
            .k3-sent-arrow { color: var(--color-text-dim, #aaa); font-size: 11px; }
            .k3-sent-interp {
                padding: 6px 10px; border-radius: 6px; font-size: 12px; font-weight: 600;
                text-align: center; margin-bottom: 8px;
            }
            .k3-sent-interp.pos { background: var(--color-sentiment-pos-bg); color: var(--color-sentiment-pos); }
            .k3-sent-interp.neu { background: var(--color-sentiment-neu-bg); color: var(--color-sentiment-neu); }
            .k3-sent-interp.neg { background: var(--color-sentiment-neg-bg); color: var(--color-sentiment-neg); }
            .k3-sent-summary { font-size: 11px; color: var(--color-text-dim); text-align: center; }

            /* Stats grid */
            .k3-stat-strip {
                display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;
                padding: 12px; background: var(--color-surface, #fff);
                border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,0.07);
            }
            .k3-stat { text-align: center; padding: 8px 4px; }
            .k3-stat-value {
                font-family: var(--font-heading, 'Playfair Display', Georgia, serif);
                font-size: 20px; font-weight: 700; color: var(--brand-primary);
                line-height: 1.2;
            }
            .k3-stat-value.green { color: var(--color-sentiment-pos, #2E9E6B); }
            .k3-stat-value.gold { color: var(--color-sentiment-neu, #C8962A); }
            .k3-stat-label { font-size: 10px; color: var(--color-text-dim); text-transform: uppercase; margin-top: 3px; }

            /* Products as chips */
            .k3-products { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--color-border, #eee); }
            .k3-products h4 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--color-text-dim); margin-bottom: 8px; }
            .k3-prod-chips { display: flex; flex-wrap: wrap; gap: 4px; }
            .k3-prod-chip {
                padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 500;
                background: var(--brand-primary-light, #f1e6b2); color: var(--brand-primary, #8e631f);
            }

            /* Aktive påmindelser (flags) — CLAUDE_KUNDE_FLAGS.md */
            .k3-flags-section { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--color-border, #eee); }
            .k3-flags-section h4 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--color-text-dim); margin-bottom: 8px; }
            .k3-flag-card {
                position: relative;
                background: #fff8e7;
                border: 1px solid var(--color-orange);
                border-radius: 6px;
                padding: 8px 28px 8px 10px;
                margin-bottom: 6px;
            }
            .k3-flag-title { font-size: 13px; font-weight: 700; color: var(--color-text); line-height: 1.3; }
            .k3-flag-body { font-size: 12px; color: var(--color-text); margin-top: 3px; line-height: 1.4; white-space: pre-wrap; word-wrap: break-word; }
            .k3-flag-meta { font-size: 11px; color: var(--color-text-dim); margin-top: 4px; }
            .k3-flag-remove {
                position: absolute; top: 4px; right: 4px;
                width: 22px; height: 22px; border-radius: 50%;
                border: none; background: transparent; color: var(--color-text-dim);
                cursor: pointer; font-size: 16px; line-height: 1;
                font-family: inherit;
            }
            .k3-flag-remove:hover { background: rgba(0,0,0,0.06); color: var(--color-red); }

            /* Tilføj (påmindelse eller note) */
            .k3-quick-add { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--color-border, #eee); }
            .k3-quick-add h4 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--color-text-dim); margin-bottom: 8px; }
            .k3-qa-type { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; font-size: 12px; }
            .k3-qa-type label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
            .k3-qa-hint { color: var(--color-text-dim); font-size: 11px; }
            .k3-qa-title, .k3-qa-body {
                width: 100%; padding: 7px 8px; border-radius: 6px; border: 1px solid var(--color-border);
                font-size: 13px; font-family: inherit; margin-bottom: 6px;
            }
            .k3-qa-body { resize: vertical; min-height: 50px; }
            .k3-qa-title:focus, .k3-qa-body:focus { border-color: var(--brand-primary); outline: none; }
            .k3-qa-btn {
                padding: 5px 14px; border-radius: 6px; border: none;
                background: var(--brand-primary); color: white; font-size: 12px; font-weight: 600; cursor: pointer;
                font-family: inherit;
            }
            .k3-qa-btn:hover { filter: brightness(1.1); }

            /* Stage select */
            .k3-stage-select {
                padding: 5px 10px; border-radius: 6px; border: 1px solid var(--color-border);
                font-size: 12px; margin-top: 14px; font-family: inherit;
            }

            /* Tabs */
            .k3-tabs { display: flex; gap: 0; }
            .k3-tab {
                padding: 10px 18px; font-size: 14px; font-weight: 600; cursor: pointer;
                border-bottom: 2px solid transparent; color: var(--color-text-dim);
                transition: color .12s;
            }
            .k3-tab:hover { color: var(--color-text, #333); }
            .k3-tab.active { border-bottom-color: var(--brand-primary); color: var(--brand-primary); }

            .k3-tab-content {
                background: var(--color-surface, #fff); border-radius: 10px;
                padding: 18px; box-shadow: 0 1px 4px rgba(0,0,0,0.07);
                flex: 1; overflow-y: auto;
            }

            /* Orders */
            .k3-order-row {
                display: grid; grid-template-columns: auto 1fr auto auto auto;
                gap: 8px; align-items: center; padding: 8px 0;
                border-bottom: 1px solid var(--color-border, #eee); font-size: 14px; cursor: pointer;
            }
            .k3-order-row:hover { background: var(--brand-primary-light, #f1e6b2); margin: 0 -18px; padding: 8px 18px; }
            .k3-order-bon { font-weight: 600; color: var(--brand-primary); }
            .k3-order-status {
                display: inline-block; padding: 2px 8px; border-radius: 6px;
                font-size: 10px; font-weight: 700; background: #f0f0f0;
            }

            /* Activity form */
            .k3-activity-form { margin-bottom: 16px; padding: 14px; border-radius: 10px; background: var(--color-background, #f5f4f2); border: 1px solid var(--color-border); }
            .k3-af-row { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; align-items: center; }
            .k3-af-select { padding: 7px 12px; border-radius: 6px; border: 1px solid var(--color-border); font-size: 13px; font-family: inherit; }
            .k3-af-textarea { width: 100%; padding: 10px; border-radius: 6px; border: 1px solid var(--color-border); font-size: 13px; resize: vertical; min-height: 60px; font-family: inherit; }
            .k3-af-textarea:focus { border-color: var(--brand-primary); outline: none; }
            .k3-af-submit {
                padding: 7px 18px; border-radius: 6px; border: none;
                background: var(--brand-primary); color: white; font-size: 13px; font-weight: 600; cursor: pointer;
            }
            .k3-af-submit:hover { filter: brightness(1.1); }

            .k3-sentiment-btns { display: flex; gap: 6px; }
            .k3-sent-btn {
                width: 38px; height: 38px; border-radius: 50%; border: 2px solid var(--color-border);
                background: var(--color-surface); font-size: 18px; cursor: pointer; display: flex;
                align-items: center; justify-content: center; transition: all .12s;
            }
            .k3-sent-btn:hover { transform: scale(1.08); }
            .k3-sent-btn.selected { border-color: var(--brand-primary); background: var(--brand-primary-light); }

            /* Timeline */
            .k3-timeline { position: relative; }
            .k3-tl-filters { display: flex; gap: 5px; margin-bottom: 14px; flex-wrap: wrap; }
            .k3-tl-filter {
                padding: 4px 12px; border-radius: 16px; border: 1px solid var(--color-border);
                background: var(--color-surface); font-size: 12px; cursor: pointer; font-family: inherit;
            }
            .k3-tl-filter.active { background: var(--brand-primary); color: white; border-color: transparent; }
            .k3-tl-filter:hover:not(.active) { background: var(--color-background); }

            .k3-month-divider {
                display: flex; align-items: center; gap: 10px; margin: 16px 0 8px;
                font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px;
                color: var(--color-text-dim);
            }
            .k3-month-divider::after { content: ''; flex: 1; height: 1px; background: var(--color-border); }

            .k3-timeline-item {
                display: flex; gap: 12px; padding: 10px 0; font-size: 13px;
                position: relative;
            }
            .k3-tl-left { display: flex; flex-direction: column; align-items: center; width: 32px; flex-shrink: 0; }
            .k3-tl-icon {
                width: 32px; height: 32px; border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                font-size: 14px; flex-shrink: 0;
            }
            .k3-tl-icon.type-call { background: var(--color-sentiment-pos-bg, #E6F7F0); }
            .k3-tl-icon.type-note { background: var(--color-sentiment-neu-bg, #FBF3E2); }
            .k3-tl-icon.type-meeting { background: var(--color-sentiment-pos-bg, #E6F7F0); }
            .k3-tl-icon.type-task { background: #EEF0FB; }
            .k3-tl-icon.type-followup { background: #f0eded; }
            .k3-tl-icon.type-email { background: #f0eded; }
            .k3-tl-icon.type-offer { background: var(--color-sentiment-neu-bg, #FBF3E2); }
            .k3-tl-connector { flex: 1; width: 2px; background: var(--color-border, #eee); margin-top: 4px; }

            .k3-tl-card {
                flex: 1; min-width: 0; background: var(--color-surface, #fff);
                border: 1px solid var(--color-border, #eee); border-radius: 10px;
                padding: 10px 14px; transition: border-color .12s;
            }
            .k3-tl-card:hover { border-color: var(--brand-primary, #8e631f); }
            .k3-tl-header { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; flex-wrap: wrap; }
            .k3-tl-type { font-weight: 600; font-size: 13px; }
            .k3-tl-who {
                padding: 1px 8px; border-radius: 10px; font-size: 10px; font-weight: 600;
                background: var(--color-background, #f5f4f2); color: var(--color-text-dim);
            }
            .k3-tl-time { font-size: 11px; color: var(--color-text-dim); margin-left: auto; white-space: nowrap; }
            .k3-tl-text { color: var(--color-text-dim); font-size: 13px; line-height: 1.5; }
            .k3-tl-footer { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
            .k3-tl-bon-ref {
                display: inline-flex; align-items: center; gap: 4px;
                padding: 3px 8px; border-radius: 6px; font-size: 11px;
                background: var(--brand-primary-light, #f1e6b2); color: var(--brand-primary);
                font-weight: 600;
            }
            .k3-tl-sentiment {
                display: inline-flex; align-items: center; gap: 3px;
                padding: 2px 8px; border-radius: 8px; font-size: 11px; font-weight: 600;
            }
            .k3-tl-sentiment.positive { background: var(--color-sentiment-pos-bg, #E6F7F0); color: var(--color-sentiment-pos, #2E9E6B); }
            .k3-tl-sentiment.negative { background: var(--color-sentiment-neg-bg, #FBE9E9); color: var(--color-sentiment-neg, #C94040); }
            .k3-tl-sentiment.neutral { background: var(--color-sentiment-neu-bg, #FBF3E2); color: var(--color-sentiment-neu, #C8962A); }

            /* Mail */
            .k3-mail-compose { padding: 14px; border-radius: 10px; background: var(--color-background, #f5f4f2); border: 1px solid var(--color-border); margin-bottom: 16px; }
            .k3-mail-field { margin-bottom: 8px; }
            .k3-mail-field label { display: block; font-size: 11px; font-weight: 700; color: var(--color-text-dim); text-transform: uppercase; margin-bottom: 3px; }
            .k3-mail-input { width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--color-border); font-size: 13px; font-family: inherit; }
            .k3-mail-input:focus { border-color: var(--brand-primary); outline: none; }
            .k3-mail-body { width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--color-border); font-size: 13px; resize: vertical; min-height: 100px; font-family: inherit; }
            .k3-mail-body:focus { border-color: var(--brand-primary); outline: none; }
            .k3-mail-send { padding: 8px 20px; border-radius: 6px; border: none; background: var(--brand-primary); color: white; font-size: 13px; font-weight: 600; cursor: pointer; }
            .k3-mail-msg { padding: 12px; margin-bottom: 10px; border-radius: 14px; max-width: 82%; }
            .k3-mail-msg.in { background: #f0f4f8; align-self: flex-start; border-bottom-left-radius: 4px; }
            .k3-mail-msg.out { background: #f0f7f0; align-self: flex-end; border-bottom-right-radius: 4px; }
            .k3-mail-msg-header { font-size: 11px; color: var(--color-text-dim); margin-bottom: 4px; display: flex; justify-content: space-between; }
            .k3-mail-msg-body { font-size: 13px; white-space: pre-wrap; line-height: 1.5; }
        </style>

        <div class="k3-layout">
            <div class="k3-left" id="k3Left">
                <div class="k3-back" onclick="_k3GoBack()">← Alle kunder</div>
                <div id="k3Profile">Indlæser...</div>
            </div>
            <div class="k3-right">
                <div class="k3-stat-strip" id="k3StatStrip"></div>
                <div class="k3-tabs" id="k3Tabs">
                    <div class="k3-tab active" data-tab="orders">Ordrer</div>
                    <div class="k3-tab" data-tab="activity">Aktivitet</div>
                    <div class="k3-tab" data-tab="offers">Tilbud</div>
                    <div class="k3-tab" data-tab="mail">Mail</div>
                </div>
                <div class="k3-tab-content" id="k3TabContent"></div>
            </div>
        </div>
    `;

    document.getElementById('k3Tabs').addEventListener('click', (e) => {
        const tab = e.target.closest('.k3-tab');
        if (!tab) return;
        _k3Tab = tab.dataset.tab;
        document.querySelectorAll('.k3-tab').forEach(t => t.classList.toggle('active', t === tab));
        _k3RenderTab();
    });
}

// ─── Data loading ───────────────────────────────────────────

async function _k3LoadData() {
    if (!_k3Active || !_k3CustomerId) return;
    try {
        _k3Data = await fetchCrmCustomer(_k3CustomerId);
        _k3RenderProfile();
        _k3RenderStatStrip();
        _k3RenderTab();
    } catch (err) {
        console.error('[k3] Load error:', err);
        const el = document.getElementById('k3Profile');
        if (el) el.textContent = 'Fejl: ' + err.message;
    }
}

// ─── Profile (left panel) ───────────────────────────────────

function _k3RenderProfile() {
    const el = document.getElementById('k3Profile');
    if (!el || !_k3Data) return;
    const c = _k3Data.customer;
    const s = _k3Data.stats;

    const stageClass = 'k3-stage-' + (c.stage || 'active');
    const stageName = { vip: 'VIP', active: 'AKTIV', dormant: 'SOVENDE', lead: 'LEAD' }[c.stage || 'active'];
    const fullName = ((c.first_name || '') + ' ' + (c.last_name || '')).trim();
    const initial = (c.company_name || fullName || '?').charAt(0).toUpperCase();

    let html = '';

    // Avatar row
    html += '<div class="k3-avatar-row">' +
        '<div class="k3-avatar">' + initial + '</div>' +
        '<div class="k3-name-block">' +
            '<div class="k3-name">' + fullName + '</div>' +
            (c.company_name && c.company_id
                ? '<div class="k3-company"><a href="?view=kontakter&tab=firmaer&company=' + c.company_id + '" class="k3-company-link" data-company-id="' + c.company_id + '">' + c.company_name + ' →</a></div>'
                : (c.company_name ? '<div class="k3-company">' + c.company_name + '</div>' : '')) +
            '<span class="k3-stage-badge ' + stageClass + '">' + stageName + '</span>' +
        '</div>' +
    '</div>';

    // RFM badge (if available)
    if (_k3Data.rfm) {
        const rfm = _k3Data.rfm;
        html += '<div style="margin:8px 0;padding:8px 12px;background:#faf8f5;border-radius:6px;border:1px solid #eee;font-size:12px">' +
            '<div style="display:flex;align-items:center;gap:10px">' +
                '<span style="font-size:16px;font-weight:700;font-family:var(--font-heading,serif)">' + rfm.rfm_total + '</span>' +
                '<span style="color:#888">RFM</span>' +
                '<span style="display:inline-flex;gap:4px">' +
                    '<span title="Recency" style="color:#4a90d9">R:' + rfm.r_score + '</span>' +
                    '<span title="Frequency" style="color:#5cb85c">F:' + rfm.f_score + '</span>' +
                    '<span title="Monetary" style="color:#f0ad4e">M:' + rfm.m_score + '</span>' +
                '</span>' +
                (rfm.stage_locked ? '<span style="font-size:10px" title="Manuelt sat stadie">🔒</span>' : '') +
            '</div>' +
        '</div>';
    }

    // Contact info
    html += '<div class="k3-contact-section">' +
        '<div class="k3-contact-row"><span class="k3-contact-icon">📞</span>' +
            (c.phone ? '<a href="tel:' + c.phone.replace(/\s/g, '') + '">' + c.phone + '</a>' : '<span style="color:var(--color-text-dim)">—</span>') + '</div>' +
        '<div class="k3-contact-row"><span class="k3-contact-icon">✉️</span>' +
            (c.email ? '<a href="mailto:' + c.email + '">' + c.email + '</a>' : '<span style="color:var(--color-text-dim)">—</span>') + '</div>' +
    '</div>';

    // Sentiment trendline
    html += _k3BuildSentimentTrend();

    // Products as chips
    if (_k3Data.products.length) {
        html += '<div class="k3-products"><h4>Typiske produkter</h4>' +
            '<div class="k3-prod-chips">' +
            _k3Data.products.slice(0, 6).map(p =>
                '<span class="k3-prod-chip">' + p.product_name + ' (' + p.total_qty + ')</span>'
            ).join('') +
            '</div></div>';
    }

    // Aktive påmindelser (vises kun hvis der er nogle) — jf. CLAUDE_KUNDE_FLAGS.md
    if (_k3Data.flags && _k3Data.flags.length) {
        html += '<div class="k3-flags-section">' +
            '<h4>Aktive påmindelser</h4>' +
            _k3Data.flags.map(f => {
                const ackCount = f.ack_count || 0;
                const ackMeta = ackCount > 0
                    ? ' · Forstået på ' + ackCount + ' bon' + (ackCount === 1 ? '' : 'er')
                    : '';
                return '<div class="k3-flag-card" data-flag-id="' + f.id + '">' +
                    '<button class="k3-flag-remove" title="Fjern permanent" onclick="_k3RemoveFlag(' + f.id + ')">×</button>' +
                    '<div class="k3-flag-title">🚩 ' + esc(f.title) + '</div>' +
                    (f.body ? '<div class="k3-flag-body">' + esc(f.body) + '</div>' : '') +
                    '<div class="k3-flag-meta">Tilføjet ' + formatDanishDate((f.created_at || '').slice(0, 10)) +
                        (f.created_by_name ? ' af ' + esc(f.created_by_name) : '') +
                        ackMeta +
                    '</div>' +
                '</div>';
            }).join('') +
        '</div>';
    }

    // Kombineret tilføj-input (erstatter den gamle Hurtig note)
    html += '<div class="k3-quick-add">' +
        '<h4>Tilføj</h4>' +
        '<div class="k3-qa-type">' +
            '<label><input type="radio" name="k3qaType" value="flag" checked> Påmindelse <span class="k3-qa-hint">(hejses på fremtidige bonner)</span></label>' +
            '<label><input type="radio" name="k3qaType" value="note"> Note <span class="k3-qa-hint">(gemmes i aktivitet)</span></label>' +
        '</div>' +
        '<input type="text" id="k3QaTitle" class="k3-qa-title" placeholder="Titel">' +
        '<textarea id="k3QaBody" class="k3-qa-body" placeholder="Detalje (valgfri)"></textarea>' +
        '<button class="k3-qa-btn" onclick="_k3SubmitQuickAdd()">Gem</button>' +
    '</div>';

    // Stage selector
    html += '<select class="k3-stage-select" id="k3StageSelect" onchange="_k3ChangeStage(this.value)">' +
        ['lead', 'active', 'dormant', 'vip'].map(st =>
            '<option value="' + st + '"' + (st === (c.stage || 'active') ? ' selected' : '') + '>' +
                { lead: 'Lead', active: 'Aktiv', dormant: 'Sovende', vip: 'VIP' }[st] + '</option>'
        ).join('') +
    '</select>';

    el.innerHTML = html;

    // Wire up firma-link cross-link til Firma 360°
    const firmaLink = el.querySelector('.k3-company-link');
    if (firmaLink) {
        firmaLink.addEventListener('click', (e) => {
            e.preventDefault();
            const cid = parseInt(firmaLink.dataset.companyId, 10);
            if (typeof window.openFirma360 === 'function') {
                window.openFirma360(cid);
            }
        });
    }
}

// ─── Sentiment trendline ────────────────────────────────────

function _k3BuildSentimentTrend() {
    if (!_k3Data || !_k3Data.activities) return '';

    const sentActivities = _k3Data.activities
        .filter(a => a.sentiment)
        .slice(0, 6);

    // Reverse so oldest is first (left to right = chronological)
    const dots = [...sentActivities].reverse();

    // Pad to 6
    while (dots.length < 6) dots.unshift(null);

    const emojiMap = { positive: '😊', neutral: '😐', negative: '😟' };
    const classMap = { positive: 'pos', neutral: 'neu', negative: 'neg' };

    const dotsHtml = dots.map((d, i) => {
        const dot = d ?
            '<div class="k3-sent-dot ' + classMap[d.sentiment] + '">' + emojiMap[d.sentiment] + '</div>' :
            '<div class="k3-sent-dot empty"></div>';
        const arrow = i < 5 ? '<span class="k3-sent-arrow">›</span>' : '';
        return dot + arrow;
    }).join('');

    // Interpretation
    const recent = sentActivities.slice(0, 3);
    let interpClass = 'neu';
    let interpText = 'Neutral stemning';
    if (recent.length > 0) {
        const posCount = recent.filter(a => a.sentiment === 'positive').length;
        const negCount = recent.filter(a => a.sentiment === 'negative').length;
        if (posCount > negCount) { interpClass = 'pos'; interpText = 'Positiv udvikling'; }
        else if (negCount > posCount) { interpClass = 'neg'; interpText = 'Negativ tendens'; }
    }

    // Counts
    const posTotal = sentActivities.filter(a => a.sentiment === 'positive').length;
    const neuTotal = sentActivities.filter(a => a.sentiment === 'neutral').length;
    const negTotal = sentActivities.filter(a => a.sentiment === 'negative').length;

    return '<div class="k3-sentiment-section">' +
        '<div class="k3-sent-title">Stemning over tid</div>' +
        '<div class="k3-sent-dots">' + dotsHtml + '</div>' +
        '<div class="k3-sent-interp ' + interpClass + '">' + interpText + '</div>' +
        '<div class="k3-sent-summary">😊 ' + posTotal + ' gode · 😐 ' + neuTotal + ' neutrale · 😟 ' + negTotal + ' dårlige</div>' +
    '</div>';
}

// ─── Stat strip (above tabs) ────────────────────────────────

function _k3RenderStatStrip() {
    const el = document.getElementById('k3StatStrip');
    if (!el || !_k3Data) return;
    const s = _k3Data.stats;

    // Find sentiment summary for KPI
    const sentActivities = (_k3Data.activities || []).filter(a => a.sentiment);
    const lastSent = sentActivities.length > 0 ? sentActivities[0].sentiment : null;
    const sentEmoji = { positive: '😊', neutral: '😐', negative: '😟' }[lastSent] || '—';
    const sentClass = lastSent === 'positive' ? 'green' : lastSent === 'negative' ? '' : 'gold';

    // Next event — find tidligste fremtidige bon ELLER planlagte meeting
    const todayIso = new Date().toISOString().slice(0, 10);
    const futureOrders = (_k3Data.orders || [])
        .filter(o => o.delivery_date >= todayIso)
        .map(o => ({ when: o.delivery_date, kind: 'order', label: o.delivery_date }));
    const futureMeetings = (_k3Data.activities || [])
        .filter(a => a.type === 'meeting' && !a.done_at && a.due_at && a.due_at.slice(0,10) >= todayIso)
        .map(a => ({
            when: a.due_at.slice(0, 10),
            kind: 'meeting',
            label: a.due_at.slice(0,10) + ' · ' + (a.meeting_type_emoji || '🤝')
        }));
    const candidates = futureOrders.concat(futureMeetings).sort((a,b) => a.when < b.when ? -1 : 1);
    const nextEvent = candidates.length > 0 ? candidates[0].label : '—';

    el.innerHTML =
        '<div class="k3-stat"><div class="k3-stat-value">' + (s.total_orders || 0) + '</div><div class="k3-stat-label">Ordrer</div></div>' +
        '<div class="k3-stat"><div class="k3-stat-value">' + Math.round(s.total_revenue || 0).toLocaleString('da-DK') + '</div><div class="k3-stat-label">Omsætning</div></div>' +
        '<div class="k3-stat"><div class="k3-stat-value ' + sentClass + '">' + sentEmoji + '</div><div class="k3-stat-label">Stemning</div></div>' +
        '<div class="k3-stat"><div class="k3-stat-value">' + nextEvent + '</div><div class="k3-stat-label">Næste event</div></div>';
}

// ─── Tab rendering ──────────────────────────────────────────

function _k3RenderTab() {
    if (!_k3Data) return;
    const el = document.getElementById('k3TabContent');
    if (!el) return;

    if (_k3Tab === 'orders') _k3RenderOrders(el);
    else if (_k3Tab === 'activity') _k3RenderActivity(el);
    else if (_k3Tab === 'offers') _k3RenderOffers(el);
    else if (_k3Tab === 'mail') _k3RenderMail(el);
}

function _k3RenderOrders(el) {
    const orders = _k3Data.orders;
    if (!orders.length) { el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--color-text-dim);">Ingen ordrer</div>'; return; }

    el.innerHTML = orders.map(o =>
        '<div class="k3-order-row" onclick="' + (_k3Opts.openDrawer ? '_k3Opts.openDrawer(' + o.id + ')' : '') + '">' +
            '<span class="k3-order-bon">#' + o.bon_number + '</span>' +
            '<span>' + o.delivery_date + '</span>' +
            '<span>' + (o.pax || '—') + ' pax</span>' +
            '<span>' + (o.total_price ? Math.round(o.total_price).toLocaleString('da-DK') + ' kr' : '—') + '</span>' +
            '<span class="k3-order-status">' + o.status + '</span>' +
        '</div>'
    ).join('');
}

let _k3ActFilter = 'all';

function _k3RenderActivity(el) {
    const typeIcons = { call: '📞', service_call: '📞', meeting: '🤝', task: '📋', note: '📝', followup: '🔔', offer_sent: '📤', email_in: '📥', email_out: '📤' };
    const typeLabels = { call: 'Opkald', service_call: 'Service-kald', meeting: 'Møde', task: 'Opgave', note: 'Note', followup: 'Opfølgning', offer_sent: 'Tilbud sendt', email_in: 'Mail ind', email_out: 'Mail ud' };
    const typeIconClasses = { call: 'type-call', service_call: 'type-call', meeting: 'type-meeting', task: 'type-task', note: 'type-note', followup: 'type-followup', offer_sent: 'type-offer', email_in: 'type-email', email_out: 'type-email' };
    const sentimentEmoji = { positive: '😊', neutral: '😐', negative: '😟' };
    const sentimentLabel = { positive: 'God', neutral: 'Neutral', negative: 'Dårlig' };
    const resultLabels = { reached: 'Nået', no_answer: 'Intet svar', busy: 'Optaget', voicemail: 'Besked', callback: 'Callback', email_instead: 'Email' };
    const MONTH_NAMES_DA = ['Januar','Februar','Marts','April','Maj','Juni','Juli','August','September','Oktober','November','December'];

    // Activity form
    let html = '<div class="k3-activity-form">' +
        '<div class="k3-af-row">' +
            '<select class="k3-af-select" id="k3ActType">' +
                '<option value="call">Opkald</option>' +
                '<option value="service_call">Service-kald</option>' +
                '<option value="note">Note</option>' +
                '<option value="meeting">Møde</option>' +
                '<option value="task">Opgave</option>' +
                '<option value="followup">Opfølgning</option>' +
            '</select>' +
            '<select class="k3-af-select" id="k3ActPurpose" style="min-width:120px">' +
                '<option value="">— Formål —</option>' +
                (_k3Purposes || []).map(p =>
                    '<option value="' + p.id + '">' + (p.emoji || '') + ' ' + p.label + '</option>'
                ).join('') +
            '</select>' +
            '<select class="k3-af-select" id="k3ActResult" style="display:none;">' +
                '<option value="">— Resultat —</option>' +
                '<option value="reached">Nået</option>' +
                '<option value="no_answer">Intet svar</option>' +
                '<option value="busy">Optaget</option>' +
                '<option value="voicemail">Besked</option>' +
                '<option value="callback">Callback</option>' +
                '<option value="email_instead">Email i stedet</option>' +
            '</select>' +
            '<div class="k3-sentiment-btns" id="k3Sentiment" style="display:none;">' +
                '<button class="k3-sent-btn" data-s="positive" onclick="_k3ToggleSentiment(this)">😊</button>' +
                '<button class="k3-sent-btn" data-s="neutral" onclick="_k3ToggleSentiment(this)">😐</button>' +
                '<button class="k3-sent-btn" data-s="negative" onclick="_k3ToggleSentiment(this)">😟</button>' +
            '</div>' +
        '</div>' +
        '<textarea class="k3-af-textarea" id="k3ActText" placeholder="Noter..."></textarea>' +
        '<div class="k3-af-row" style="justify-content:flex-end;">' +
            '<button class="k3-af-submit" onclick="_k3SubmitActivity()">Log aktivitet</button>' +
        '</div>' +
    '</div>';

    // Filter chips
    const filters = [
        { key: 'all', label: 'Alle' },
        { key: 'call', label: 'Opkald' },
        { key: 'note', label: 'Noter' },
        { key: 'meeting', label: 'Møder' },
        { key: 'sentiment', label: '😊 Med smiley' },
    ];
    html += '<div class="k3-tl-filters" id="k3TlFilters">' +
        filters.map(f =>
            '<button class="k3-tl-filter' + (f.key === _k3ActFilter ? ' active' : '') + '" data-filter="' + f.key + '">' + f.label + '</button>'
        ).join('') +
    '</div>';

    // Filter activities
    let activities = _k3Data.activities || [];
    if (_k3ActFilter === 'call') activities = activities.filter(a => ['call', 'service_call'].includes(a.type));
    else if (_k3ActFilter === 'note') activities = activities.filter(a => a.type === 'note');
    else if (_k3ActFilter === 'meeting') activities = activities.filter(a => a.type === 'meeting');
    else if (_k3ActFilter === 'sentiment') activities = activities.filter(a => a.sentiment);

    // Timeline with month dividers
    html += '<div class="k3-timeline">';
    if (activities.length) {
        let lastMonth = '';
        activities.forEach((a, idx) => {
            // Month divider
            const dateStr = (a.created_at || '').substring(0, 7); // "2026-03"
            if (dateStr && dateStr !== lastMonth) {
                lastMonth = dateStr;
                const parts = dateStr.split('-');
                const monthName = MONTH_NAMES_DA[parseInt(parts[1]) - 1] || '';
                html += '<div class="k3-month-divider">' + monthName + ' ' + parts[0] + '</div>';
            }

            const sentBadge = a.sentiment ?
                '<span class="k3-tl-sentiment ' + a.sentiment + '">' + sentimentEmoji[a.sentiment] + ' ' + sentimentLabel[a.sentiment] + '</span>' : '';
            const resultText = a.result ? (resultLabels[a.result] || a.result) : '';
            const label = typeLabels[a.type] || a.type;
            const iconClass = typeIconClasses[a.type] || 'type-note';
            const icon = typeIcons[a.type] || '•';
            const isLast = idx === activities.length - 1;
            const time = (a.created_at || '').substring(0, 16).replace('T', ' ');
            const who = a.user_name || '';

            // Meeting-aktiviteter er klikbare (åbner detalje-modal)
            const isMeeting = a.type === 'meeting';
            const cardCursor = isMeeting ? 'cursor:pointer;' : '';
            const cardClick = isMeeting ? ' onclick="_k3OpenActivityDetail(' + a.id + ')"' : '';

            // Vis møde-tidspunkt (due_at) hvis det er et meeting — vigtigere end created_at
            let timeDisplay = time;
            if (isMeeting && a.due_at) {
                const due = a.due_at.replace('T', ' ').slice(0, 16);
                timeDisplay = '🗓️ ' + due;
            }

            html += '<div class="k3-timeline-item">' +
                '<div class="k3-tl-left">' +
                    '<div class="k3-tl-icon ' + iconClass + '">' + icon + '</div>' +
                    (!isLast ? '<div class="k3-tl-connector"></div>' : '') +
                '</div>' +
                '<div class="k3-tl-card" style="' + cardCursor + '"' + cardClick + '>' +
                    '<div class="k3-tl-header">' +
                        '<span class="k3-tl-type">' + label + (resultText ? ' → ' + resultText : '') + '</span>' +
                        (who ? '<span class="k3-tl-who">' + who + '</span>' : '') +
                        '<span class="k3-tl-time">' + timeDisplay + '</span>' +
                    '</div>' +
                    (a.text ? '<div class="k3-tl-text">' + a.text + '</div>' : '') +
                    ((sentBadge || a.bon_number) ? '<div class="k3-tl-footer">' +
                        sentBadge +
                        (a.bon_number ? '<span class="k3-tl-bon-ref">#' + a.bon_number + '</span>' : '') +
                    '</div>' : '') +
                '</div>' +
            '</div>';
        });
    } else {
        html += '<div style="text-align:center;padding:20px;color:var(--color-text-dim);">Ingen aktiviteter' +
            (_k3ActFilter !== 'all' ? ' med dette filter' : ' endnu') + '</div>';
    }
    html += '</div>';

    el.innerHTML = html;

    // Wire filter chips
    document.getElementById('k3TlFilters')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.k3-tl-filter');
        if (!btn) return;
        _k3ActFilter = btn.dataset.filter;
        _k3RenderActivity(el);
    });

    // Wire type/result toggling
    const typeEl = document.getElementById('k3ActType');
    const resultEl = document.getElementById('k3ActResult');
    const sentEl = document.getElementById('k3Sentiment');

    typeEl.addEventListener('change', () => {
        const isCall = ['call', 'service_call'].includes(typeEl.value);
        resultEl.style.display = isCall ? '' : 'none';
        if (!isCall) resultEl.value = '';
        // Sentiment er altid tilgængeligt — uanset aktivitetstype
        sentEl.style.display = typeEl.value ? 'flex' : 'none';
    });
    resultEl.addEventListener('change', () => {
        // Sentiment forbliver synligt — result-valg påvirker det ikke
    });
}

async function _k3RenderOffers(el) {
    if (!_k3Data) { el.innerHTML = ''; return; }
    const customerId = _k3Data.customer?.id || _k3Data.id || _k3Data.customer_id;
    const statusLabels = { draft: 'Kladde', sent: 'Sendt', won: 'Vundet', lost: 'Tabt', expired: 'Udl\u00f8bet' };
    const statusColors = { draft: '#8a8580', sent: '#7594b3', won: '#6ab04c', lost: '#bc181b', expired: '#d7d1ca' };

    // Hent tilbud via quotes API (som er bons med is_offer=1)
    let quotes = [];
    try {
        quotes = await fetchQuotes({ customer_id: customerId });
    } catch (_) {}

    let h = '<div style="display:flex;justify-content:flex-end;margin-bottom:12px">' +
        '<button onclick="_k3NewQuote()" style="font-size:.78rem;padding:5px 14px;border:1.5px solid var(--color-border);border-radius:8px;background:var(--color-surface);cursor:pointer;font-weight:600;color:var(--brand-primary)">+ Opret tilbud</button></div>';

    if (!quotes.length) {
        h += '<div style="text-align:center;padding:20px;color:var(--color-text-dim);">Ingen tilbud for denne kunde</div>';
        el.innerHTML = h;
        return;
    }
    h += quotes.map(q => {
        const s = statusLabels[q.status] || q.status;
        const c = statusColors[q.status] || '#8a8580';
        return '<div class="k3-order-row" style="cursor:pointer" onclick="_k3OpenQuote(' + q.id + ')">' +
            '<span class="k3-order-bon">' + (q.quote_number || '') + '</span>' +
            '<span>' + (q.delivery_date || q.quote_date || '\u2014') + '</span>' +
            '<span>' + (q.total_price != null ? Math.round(q.total_price).toLocaleString('da-DK') + ' kr' : '\u2014') + '</span>' +
            '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:.7rem;font-weight:600;background:' + c + '20;color:' + c + '">' + s + '</span>' +
        '</div>';
    }).join('');
    el.innerHTML = h;
}

function _k3NewQuote() {
    if (!_k3Data) return;
    const customerId = _k3Data.customer?.id || _k3Data.id || _k3Data.customer_id;
    if (typeof switchView === 'function') {
        const url = new URL(window.location);
        url.searchParams.set('view', 'tilbud');
        url.searchParams.set('customer', customerId);
        history.replaceState({}, '', url);
        switchView('tilbud');
    }
}

function _k3OpenQuote(quoteId) {
    // Navigér til tilbud-view og åbn tilbuddet i wizard
    if (typeof _tOpenQuote === 'function' && typeof switchView === 'function') {
        const url = new URL(window.location);
        url.searchParams.set('view', 'tilbud');
        url.searchParams.delete('quote');
        history.replaceState({}, '', url);
        switchView('tilbud');
        // Åbn efter init har renderet listen
        setTimeout(() => _tOpenQuote(quoteId), 100);
    }
}

// ─── Activity form helpers ──────────────────────────────────

function _k3ToggleSentiment(btn) {
    document.querySelectorAll('.k3-sent-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
}

async function _k3SubmitActivity() {
    const type = document.getElementById('k3ActType').value;
    const result = document.getElementById('k3ActResult').value || null;
    const text = document.getElementById('k3ActText').value.trim();
    const sentBtn = document.querySelector('.k3-sent-btn.selected');
    const sentiment = sentBtn ? sentBtn.dataset.s : null;
    const purposeEl = document.getElementById('k3ActPurpose');
    const purpose_id = purposeEl?.value ? parseInt(purposeEl.value) : null;

    if (!text) { alert('Skriv en note'); return; }

    try {
        await postCrmActivity({
            customer_id: _k3CustomerId,
            type, result, sentiment, text, purpose_id,
        });
        _k3LoadData();
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

async function _k3SubmitQuickAdd() {
    const typeEl = document.querySelector('input[name="k3qaType"]:checked');
    const type   = typeEl ? typeEl.value : 'flag';
    const title  = (document.getElementById('k3QaTitle')?.value || '').trim();
    const body   = (document.getElementById('k3QaBody')?.value || '').trim();
    if (!title) { alert('Skriv en titel'); return; }

    try {
        if (type === 'flag') {
            await createFlag('customer', _k3CustomerId, title, body || null);
        } else {
            // Note → eksisterende crm_activities-flow. Title + body kombineres til ét tekstfelt.
            await postCrmActivity({
                customer_id: _k3CustomerId,
                type: 'note',
                text: body ? title + '\n\n' + body : title,
            });
        }
        document.getElementById('k3QaTitle').value = '';
        document.getElementById('k3QaBody').value = '';
        _k3LoadData();
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

async function _k3RemoveFlag(flagId) {
    if (!confirm('Fjern denne påmindelse permanent?')) return;
    try {
        await dismissFlagApi(flagId, null, 'Fjernet fra kundekortet');
        _k3LoadData();
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

async function _k3ChangeStage(stage) {
    try {
        await patchCrmCustomerStage(_k3CustomerId, stage);
        _k3LoadData();
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

// ─── Mail tab ───────────────────────────────────────────────

async function _k3RenderMail(el) {
    if (!_k3Data) return;
    const c = _k3Data.customer;
    const email = c.email || '';

    // Compose form
    let html = '<div class="k3-mail-compose">' +
        '<div class="k3-mail-field">' +
            '<label>Til</label>' +
            '<input type="email" class="k3-mail-input" id="k3MailTo" value="' + email + '">' +
        '</div>' +
        '<div class="k3-mail-field">' +
            '<label>Emne</label>' +
            '<input type="text" class="k3-mail-input" id="k3MailSubject" placeholder="Emne...">' +
        '</div>' +
        '<div class="k3-mail-field">' +
            '<label>Besked</label>' +
            '<textarea class="k3-mail-body" id="k3MailBody" placeholder="Skriv din besked..."></textarea>' +
        '</div>' +
        '<input type="file" id="k3MailFile" accept=".pdf,.jpg,.jpeg,.png,.gif,.xlsx,.docx" style="display:none" onchange="_k3OnFileSelected(this)">' +
        '<div id="k3MailAttachments" class="bm-attachments"></div>' +
        '<div style="display:flex;gap:8px;margin-top:6px;align-items:center;flex-wrap:wrap;position:relative;">' +
            '<button class="bm-attach" id="k3AttachBtn" onclick="_k3AttachFile()">📎 Vedhæft</button>' +
            '<button class="bm-attach" id="k3BookingLinkBtn" onclick="_k3ToggleBookingLinkPopover()">📅 Indsæt booking-link</button>' +
            '<span id="k3BookingLinkInfo" style="font-size:11px;color:var(--color-text-dim);"></span>' +
            '<button class="k3-mail-send" onclick="_k3SendMail()" style="margin-left:auto;">Send mail</button>' +
            '<div id="k3BookingLinkPopover" style="display:none;position:absolute;top:38px;left:120px;background:#fff;border:1px solid var(--color-border);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.12);padding:12px;min-width:280px;z-index:50;">' +
                '<div style="font-size:11px;text-transform:uppercase;color:var(--color-text-dim);margin-bottom:6px;">Booking-link</div>' +
                '<div style="margin-bottom:8px;">' +
                    '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;margin-bottom:3px;">' +
                        '<input type="radio" name="k3BookingFlow" value="smagning" checked> Smagsprøve (kalender-side)' +
                    '</label>' +
                    '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;">' +
                        '<input type="radio" name="k3BookingFlow" value="kontakt"> Kontaktformular' +
                    '</label>' +
                '</div>' +
                '<div id="k3IntentRow" style="margin-bottom:8px;">' +
                    '<label style="font-size:11px;color:var(--color-text-dim);display:block;margin-bottom:3px;">Forvalgt mødetype</label>' +
                    '<select id="k3BookingIntentSel" style="width:100%;padding:5px 6px;border:1px solid var(--color-border);border-radius:4px;font-size:13px;">' +
                        '<option value="">— ingen forvalgt —</option>' +
                    '</select>' +
                '</div>' +
                '<div style="display:flex;gap:6px;justify-content:flex-end;">' +
                    '<button onclick="_k3CloseBookingLinkPopover()" style="padding:5px 10px;font-size:12px;background:none;border:1px solid var(--color-border);border-radius:4px;cursor:pointer;">Annuller</button>' +
                    '<button onclick="_k3InsertBookingLink()" style="padding:5px 10px;font-size:12px;background:var(--brand-primary,#8e631f);color:#fff;border:none;border-radius:4px;cursor:pointer;">Indsæt</button>' +
                '</div>' +
            '</div>' +
        '</div>' +
    '</div>';

    // Load existing mail threads for this customer's bons + direct customer mail
    try {
        const bonsWithMail = _k3Data.orders.filter(o => o.id);
        let allMessages = [];
        for (const o of bonsWithMail.slice(0, 5)) {
            try {
                const mailData = await fetchBonMail(o.id);
                if (mailData.threads) {
                    for (const t of mailData.threads) {
                        for (const m of (t.messages || [])) {
                            allMessages.push({ ...m, bon_number: o.bon_number });
                        }
                    }
                }
            } catch (e) { /* bon har ingen mail */ }
        }
        try {
            const custMailData = await fetchCustomerMail(_k3CustomerId);
            if (custMailData.threads) {
                for (const t of custMailData.threads) {
                    for (const m of (t.messages || [])) {
                        allMessages.push({ ...m });
                    }
                }
            }
        } catch (e) { /* kunde har ingen direkte mail */ }

        allMessages.sort((a, b) => (b.received_at || b.sent_at || '').localeCompare(a.received_at || a.sent_at || ''));

        if (allMessages.length) {
            html += '<h4 style="font-size:11px;text-transform:uppercase;color:var(--color-text-dim);margin:16px 0 8px;">Mail-historik</h4>';
            html += '<div style="display:flex;flex-direction:column;gap:8px">';
            html += allMessages.slice(0, 20).map(m => {
                const dir = m.direction === 'in' ? 'in' : 'out';
                const who = dir === 'in' ? (m.from_name || m.from_email || 'Ukendt') : 'Ristet Rug';
                const _k3d = parseServerDate(m.received_at || m.sent_at);
                const _k3p = n => String(n).padStart(2, '0');
                const time = _k3d
                    ? `${_k3d.getFullYear()}-${_k3p(_k3d.getMonth()+1)}-${_k3p(_k3d.getDate())} ${_k3p(_k3d.getHours())}:${_k3p(_k3d.getMinutes())}`
                    : (m.received_at || m.sent_at || '').substring(0, 16).replace('T', ' ');
                return '<div class="k3-mail-msg ' + dir + '">' +
                    '<div class="k3-mail-msg-header">' +
                        '<span>' + who + (m.bon_number ? ' · #' + m.bon_number : '') + '</span>' +
                        '<span>' + time + '</span>' +
                    '</div>' +
                    '<div style="font-size:12px;font-weight:600;margin-bottom:2px;">' + (m.subject || '') + '</div>' +
                    '<div class="k3-mail-msg-body">' + ((m.body_text || '').substring(0, 300)) + '</div>' +
                    (m.attachments && m.attachments.filter(a => a.id).length
                        ? '<div class="bm-msg-attachments">' + m.attachments.filter(a => a.id).map(a =>
                            '<a href="' + mailAttachmentUrl(a.id) + '" class="bm-msg-att" target="_blank">📎 ' + (a.filename || 'fil') + ' (' + Math.round((a.size_bytes||0)/1024) + ' KB)</a>'
                        ).join('') + '</div>'
                        : '') +
                '</div>';
            }).join('');
            html += '</div>';
        }
    } catch (err) {
        console.error('[k3] Mail load error:', err);
    }

    el.innerHTML = html;
}

let _k3Attachments = [];
let _k3BookingFlow   = 'smagning';   // valgt flow for {{booking_link}}
let _k3BookingIntent = null;          // valgt intent_meeting_type_key
let _k3BookingTypesCache = null;      // populeres ved første åbning af popover

// ─── Booking-link popover (M11) ─────────────────────────────
async function _k3ToggleBookingLinkPopover() {
    const pop = document.getElementById('k3BookingLinkPopover');
    if (!pop) return;
    const isOpen = pop.style.display !== 'none';
    if (isOpen) { pop.style.display = 'none'; return; }

    // Load mødetyper ved første åbning
    if (!_k3BookingTypesCache) {
        try {
            const r = await fetchBookingMeetingTypesIntent();
            _k3BookingTypesCache = r.meeting_types || [];
        } catch (err) {
            console.error('[k3] kunne ikke hente mødetyper:', err);
            _k3BookingTypesCache = [];
        }
    }

    const sel = document.getElementById('k3BookingIntentSel');
    if (sel) {
        sel.innerHTML = '<option value="">— ingen forvalgt —</option>' +
            _k3BookingTypesCache.map(mt =>
                '<option value="' + mt.key + '">' + (mt.emoji || '') + ' ' + mt.label +
                ' (' + mt.duration_min + ' min)' + (mt.is_bookable ? '' : ' — sælger-only') + '</option>'
            ).join('');
        sel.value = _k3BookingIntent || '';
    }

    // Hide intent row hvis flow=kontakt (ingen kalender → ingen mødetype)
    const updateIntentVisibility = () => {
        const flow = document.querySelector('input[name="k3BookingFlow"]:checked')?.value || 'smagning';
        document.getElementById('k3IntentRow').style.display = (flow === 'smagning') ? '' : 'none';
    };
    document.querySelectorAll('input[name="k3BookingFlow"]').forEach(r => {
        r.checked = (r.value === _k3BookingFlow);
        r.addEventListener('change', updateIntentVisibility);
    });
    updateIntentVisibility();

    pop.style.display = 'block';
}

function _k3CloseBookingLinkPopover() {
    const pop = document.getElementById('k3BookingLinkPopover');
    if (pop) pop.style.display = 'none';
}

function _k3InsertBookingLink() {
    const flow = document.querySelector('input[name="k3BookingFlow"]:checked')?.value || 'smagning';
    const intent = document.getElementById('k3BookingIntentSel')?.value || null;
    _k3BookingFlow = flow;
    _k3BookingIntent = intent || null;

    const ta = document.getElementById('k3MailBody');
    if (ta) {
        const start = ta.selectionStart ?? ta.value.length;
        const end   = ta.selectionEnd   ?? ta.value.length;
        const before = ta.value.slice(0, start);
        const after  = ta.value.slice(end);
        ta.value = before + '{{booking_link}}' + after;
        ta.focus();
        const cursor = start + '{{booking_link}}'.length;
        ta.setSelectionRange(cursor, cursor);
    }

    // Vis info-strip ved siden af knappen
    const info = document.getElementById('k3BookingLinkInfo');
    if (info) {
        const flowLabel = flow === 'kontakt' ? 'Kontakt' : 'Smagsprøve';
        const intentLabel = intent
            ? (_k3BookingTypesCache?.find(mt => mt.key === intent)?.label || intent)
            : null;
        info.textContent = '🔗 ' + flowLabel + (intentLabel ? ' · ' + intentLabel : '');
    }

    _k3CloseBookingLinkPopover();
}


function _k3AttachFile() {
    if (_k3Attachments.length >= 5) { alert('Max 5 vedhæftninger per mail'); return; }
    document.getElementById('k3MailFile').click();
}

async function _k3OnFileSelected(input) {
    const file = input.files[0];
    if (!file) return;
    input.value = '';
    if (file.size > 10 * 1024 * 1024) { alert('Fil er for stor (max 10 MB)'); return; }
    const btn = document.getElementById('k3AttachBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Uploader…'; }
    try {
        const result = await uploadAttachment(file, 'customer', _k3CustomerId);
        _k3Attachments.push(result);
        _k3RenderAttPills();
    } catch (err) {
        alert('Upload fejl: ' + err.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '📎 Vedhæft'; }
    }
}

function _k3RenderAttPills() {
    const el = document.getElementById('k3MailAttachments');
    if (!el) return;
    el.innerHTML = _k3Attachments.map((a, i) =>
        '<span class="bm-att-pill">📎 ' + (a.filename || 'fil') + ' (' + Math.round((a.size_bytes || 0) / 1024) + ' KB)'
        + '<span class="bm-att-remove" onclick="_k3RemoveAtt(' + i + ')"> ✕</span></span>'
    ).join('');
}

function _k3RemoveAtt(index) {
    _k3Attachments.splice(index, 1);
    _k3RenderAttPills();
}

async function _k3SendMail() {
    const to = document.getElementById('k3MailTo').value.trim();
    const subject = document.getElementById('k3MailSubject').value.trim();
    const text = document.getElementById('k3MailBody').value.trim();

    if (!to || !subject || !text) { alert('Udfyld alle felter'); return; }

    if (!_k3CustomerId) { alert('Ingen kunde valgt'); return; }

    try {
        const data = { to, subject, text };
        if (_k3Attachments.length > 0) {
            data.attachments = _k3Attachments.map(a => ({ attachment_id: a.attachment_id }));
        }
        // Hvis brugeren har indsat {{booking_link}}, send valgt flow + intent
        if (text.includes('{{booking_link}}') || subject.includes('{{booking_link}}')) {
            data.booking_flow = _k3BookingFlow;
            if (_k3BookingIntent) data.booking_intent_meeting_type = _k3BookingIntent;
        }
        await sendCustomerMail(_k3CustomerId, data);
        _k3Attachments = [];
        _k3BookingFlow = 'smagning';
        _k3BookingIntent = null;
        alert('Mail sendt!');
        _k3RenderTab();
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

function _k3GoBack() {
    const url = new URL(window.location);
    url.searchParams.delete('customer');
    history.replaceState({}, '', url);
    _k3CustomerId = null;
    _k3Data = null;
    _k3RenderSearch();
}

// ─── SSE handler ────────────────────────────────────────────

function _k3HandleSSE(eventType, data) {
    if (!_k3Active || !_k3CustomerId) return;
    if (data.customer_id === _k3CustomerId) {
        _k3LoadData();
    }
}

// ─── Activity-detalje modal ───────────────────────────────────
// Åbnes når brugeren klikker på en meeting-aktivitet i timeline.
window._k3OpenActivityDetail = function(activityId) {
    if (!_k3Data) return;
    const a = (_k3Data.activities || []).find(x => x.id === activityId);
    if (!a) return;

    const due = a.due_at ? new Date(a.due_at.replace(' ', 'T')) : null;
    const dueOk = due && !isNaN(due.getTime());

    const dayNames = ['søndag','mandag','tirsdag','onsdag','torsdag','fredag','lørdag'];
    const monthNames = ['januar','februar','marts','april','maj','juni',
                        'juli','august','september','oktober','november','december'];

    const dateLine = dueOk
        ? dayNames[due.getDay()] + ' d. ' + due.getDate() + '. ' + monthNames[due.getMonth()] + ' ' + due.getFullYear()
        : '—';
    const timeLine = dueOk
        ? String(due.getHours()).padStart(2,'0') + ':' + String(due.getMinutes()).padStart(2,'0')
        : '—';

    const sourceLabel = {
        public_smagning: 'Online (smagsprøve-side)',
        public_kontakt:  'Online (kontaktformular)',
        token_link:      'Mail-link (sælger sendte link)',
        internal:        'Manuelt oprettet'
    }[a.booked_via] || (a.booked_via || '—');

    const status = a.done_at ? '✅ Afsluttet ' + a.done_at.slice(0,16).replace('T',' ') : '🟡 Planlagt';

    const rows = [
        ['Status',     status],
        ['Dato',       dateLine],
        ['Tidspunkt',  timeLine + (a.duration_min ? ' (' + a.duration_min + ' min)' : '')],
        ['Mødetype',   (a.meeting_type_emoji ? a.meeting_type_emoji + ' ' : '') + (a.meeting_type_label || '—')],
        ['Antal gæster', a.guest_count != null ? a.guest_count : '—'],
        ['Eventtype',  a.event_type || '—'],
        ['Booket via', sourceLabel],
        ['Sælger',     a.user_name || '—'],
        ['Oprettet',   (a.created_at || '—').replace('T',' ').slice(0,16)]
    ];

    const tableHtml = '<table style="width:100%;border-collapse:collapse;">' +
        rows.map(([k,v]) =>
            '<tr><td style="padding:6px 8px;color:var(--color-text-dim,#888);width:140px;vertical-align:top;font-size:13px;">' +
                k + '</td><td style="padding:6px 8px;font-size:14px;">' + escapeAttr(String(v)) + '</td></tr>'
        ).join('') +
    '</table>';

    const messageHtml = a.text
        ? '<div style="margin-top:18px;padding:12px;background:#f9f7f4;border-radius:8px;">' +
            '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--color-text-dim,#888);letter-spacing:.5px;margin-bottom:6px">Besked / note</div>' +
            '<div style="font-size:14px;white-space:pre-line;">' + escapeAttr(a.text) + '</div>' +
          '</div>'
        : '';

    const actionsHtml = !a.done_at
        ? '<div style="margin-top:18px;display:flex;gap:8px;justify-content:flex-end;">' +
            '<button onclick="_k3MarkActivityDone(' + a.id + ')" style="padding:8px 14px;border:1px solid var(--brand-primary,#8e631f);background:var(--brand-primary,#8e631f);color:#fff;border-radius:6px;cursor:pointer;font-weight:600;">✓ Markér som afholdt</button>' +
          '</div>'
        : '';

    if (typeof openModal === 'function') {
        openModal({
            title: '🤝 ' + (a.meeting_type_label || 'Møde'),
            bodyHtml: tableHtml + messageHtml + actionsHtml
        });
    }
};

window._k3MarkActivityDone = async function(activityId) {
    try {
        const r = await fetch('/api/crm/activity/' + activityId + '/done', { method: 'PATCH' });
        if (!r.ok) throw new Error('Kunne ikke markere som afholdt (' + r.status + ')');
        if (typeof closeModal === 'function') closeModal();
        if (typeof _k3LoadData === 'function') _k3LoadData();
    } catch (err) {
        alert(err.message || 'Fejl');
    }
};

function escapeAttr(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])
    );
}
