/**
 * office/views/crm-firmaer.js
 * ════════════════════════════════════════════════════════════
 * Listview af firmaer med aggregeret statistik (kunder, bons, omsætning).
 * Klik på firma → cross-link til Firma 360° (Fase 6) via
 *   ?view=kontakter&tab=firmaer&company=ID
 *
 * Filtre:
 *   • Stage (alle | aktive | sovende | VIP)
 *   • Søgning på navn / CVR / legal_name
 *
 * Henter fra GET /api/crm/companies.
 * ════════════════════════════════════════════════════════════
 */

let _cfState = {
    container: null,
    companies: [],
    stage: 'all',
    q: '',
    loading: false,
    debounceTimer: null,
    // Fase 2 multi-select: id → { id, name }
    selected: new Map(),
};

function initCrmFirmaer(container, opts = {}) {
    _cfState.container = container;
    _cfState.opts = opts;

    container.innerHTML = `
        <div class="cf-wrap">
            <div class="cf-toolbar">
                <div class="cf-stage-filters">
                    <button class="cf-chip active" data-stage="all">Alle</button>
                    <button class="cf-chip" data-stage="active">Aktive</button>
                    <button class="cf-chip" data-stage="vip">⭐ VIP</button>
                    <button class="cf-chip" data-stage="dormant">Sovende</button>
                </div>
                <input class="cf-search" type="search" placeholder="Søg firma, CVR, EAN, juridisk navn eller #id…" />
                <button type="button" class="cf-new-btn" id="cf-new-btn">+ Nyt firma</button>
            </div>
            <div class="cf-status" id="cf-status"></div>
            <div id="cf-select-bar"></div>
            <div class="cf-list" id="cf-list"></div>
        </div>
    `;
    cfEnsureSelectStyles();

    // Stage-filter
    container.querySelectorAll('.cf-chip').forEach(btn => {
        btn.addEventListener('click', () => {
            container.querySelectorAll('.cf-chip').forEach(b =>
                b.classList.toggle('active', b === btn)
            );
            _cfState.stage = btn.dataset.stage;
            cfLoad();
        });
    });

    // Søgning
    const searchEl = container.querySelector('.cf-search');
    searchEl.addEventListener('input', () => {
        clearTimeout(_cfState.debounceTimer);
        _cfState.debounceTimer = setTimeout(() => {
            _cfState.q = searchEl.value.trim();
            cfLoad();
        }, 280);
    });

    container.querySelector('#cf-new-btn').addEventListener('click', cfOpenNewFirma);

    cfLoad();
}

/* ══════════════════════════════════════════════════════════════
   + Nyt firma (#612)

   Et firma kunne kun opstå som biprodukt: via "+ Ny kunde" (som kræver en
   person der måske ikke findes) eller via en bon med et ukendt firmanavn.
   Oprydningen i kartoteket kræver at man kan lave den RIGTIGE række i hånden.

   Før oprettelse spørges /api/companies/match (samme matcher som web-
   bestillingen bruger), så et firma der allerede findes vises som
   "Findes allerede: …" med Åbn / Opret alligevel — i stedet for at blive
   endnu en dublet (#607). Serveren spærrer ikke: afdelinger under samme
   CVR er separate firmaer, så kontoret afgør.
   ══════════════════════════════════════════════════════════════ */

const _cfNew = { cvrAddress: null, dawa: null, confirmedMatchId: null, legalName: null };

function cfOpenNewFirma() {
    if (typeof openModal !== 'function') { alert('Modal-komponenten er ikke indlæst'); return; }
    _cfNew.cvrAddress = null; _cfNew.dawa = null; _cfNew.confirmedMatchId = null; _cfNew.legalName = null;

    openModal({
        title: 'Nyt firma',
        bodyHtml: `
        <div class="cf-new">
            <div class="cf-new-field">
                <label>Slå firma op i CVR</label>
                <div class="cf-new-inline">
                    <input type="text" id="cfn-cvrq" placeholder="Firmanavn, CVR-nummer eller EAN, fx CAP Partner">
                    <button type="button" class="cf-new-mini" id="cfn-cvr-search">Søg</button>
                </div>
                <div class="cf-new-cvr-results" id="cfn-cvr-results" hidden></div>
                <div class="cf-new-hint">CVR er ikke påkrævet — firmaet kan oprettes med navnet alene og beriges senere.</div>
            </div>
            <div class="cf-new-field">
                <label>Firmanavn <span class="cf-new-req">*</span></label>
                <input type="text" id="cfn-name" autocomplete="organization">
            </div>
            <div class="cf-new-row">
                <div class="cf-new-field"><label>CVR</label><input type="text" id="cfn-cvr" inputmode="numeric" maxlength="8" placeholder="8 cifre"></div>
                <div class="cf-new-field"><label>EAN</label><input type="text" id="cfn-ean" inputmode="numeric" maxlength="13" placeholder="13 cifre"></div>
            </div>
            <div class="cf-new-row">
                <div class="cf-new-field"><label>Telefon</label><input type="text" id="cfn-phone" inputmode="tel"></div>
                <div class="cf-new-field"><label>E-mail</label><input type="email" id="cfn-email"></div>
            </div>
            <div class="cf-new-field cf-new-dawa">
                <label>Adresse</label>
                <input type="text" id="cfn-dawa" placeholder="Begynd at skrive — vælg fra listen" autocomplete="off">
                <div class="cf-new-dawa-results" id="cfn-dawa-results" hidden></div>
                <div class="cf-new-dawa-selected" id="cfn-dawa-selected" hidden></div>
            </div>
            <div class="cf-new-field">
                <label>Noter</label>
                <textarea id="cfn-notes" rows="2"></textarea>
            </div>
            <div class="cf-new-match" id="cfn-match" hidden></div>
            <div class="cf-new-error" id="cfn-error" hidden></div>
            <div class="cf-new-actions">
                <button type="button" class="cf-new-cancel" id="cfn-cancel">Annullér</button>
                <button type="button" class="cf-new-submit" id="cfn-submit">Opret firma</button>
            </div>
        </div>`,
    });

    const $ = (id) => document.getElementById(id);
    $('cfn-cancel').addEventListener('click', () => closeModal());
    $('cfn-submit').addEventListener('click', cfSubmitNewFirma);
    $('cfn-cvr-search').addEventListener('click', () => cfCvrSearch($('cfn-cvrq').value));
    $('cfn-cvrq').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); cfCvrSearch($('cfn-cvrq').value); } });
    // Enter i et felt = opret, som i en almindelig formular — men ikke i textarea.
    ['cfn-name', 'cfn-cvr', 'cfn-ean', 'cfn-phone', 'cfn-email'].forEach(id => {
        $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); cfSubmitNewFirma(); } });
    });
    // Rettes noget efter et "findes allerede", skal matchet spørges igen.
    ['cfn-name', 'cfn-cvr', 'cfn-ean', 'cfn-email'].forEach(id => {
        $(id).addEventListener('input', () => { _cfNew.confirmedMatchId = null; $('cfn-match').hidden = true; });
    });
    // Et EAN eller CVR sat direkte i SIT felt skal også slå op — kontoret
    // kommer med tallet fra ordren og skriver det dér, ikke i opslagsfeltet
    // (set i drift). Kun når navnet er tomt: er det udfyldt, har man allerede
    // valgt, og et opslag må ikke overskrive det.
    const lookupFromField = (id, len) => {
        const v = $(id).value.replace(/\D/g, '');
        if (v.length === len && !$('cfn-name').value.trim()) cfCvrSearch(v, { autoApply: true });
    };
    $('cfn-ean').addEventListener('change', () => lookupFromField('cfn-ean', 13));
    $('cfn-cvr').addEventListener('change', () => lookupFromField('cfn-cvr', 8));
    cfBindDawa();
    requestAnimationFrame(() => $('cfn-cvrq').focus());
}

/**
 * Ét felt til alle tre opslag: 8 cifre → CVR-nummer; 13 cifre → EAN via
 * NemHandelsregistret (den registrerede enhed + CVR + juridisk enhed); ellers
 * navnesøgning (cvrapi først — præcis på korte navne — Virk ES som fuzzy
 * fallback). Samme to navne-kilder som KundeSoeg.cvrSearchByName.
 */
async function cfCvrSearch(raw, opts = {}) {
    const q = (raw || '').trim();
    const out = document.getElementById('cfn-cvr-results');
    const btn = document.getElementById('cfn-cvr-search');
    if (q.length < 2) return;
    btn.disabled = true; btn.textContent = '…';
    out.hidden = false; out.innerHTML = '<div class="cf-new-cvr-empty">Søger…</div>';

    const digits = q.replace(/\D/g, '');
    const tryUrl = async (url) => {
        try { const r = await fetch(url); if (!r.ok) return null; const d = await r.json(); return d; } catch (_) { return null; }
    };
    let hits = [];
    if (digits.length === 13 && digits === q.replace(/\s/g, '')) {
        const d = await tryUrl('/api/cvr/ean/' + digits);
        // Enheden fra NemHandel er navnet (afdelingen er firma-rækkens niveau);
        // den juridiske enhed bag CVR'et vises som meta og gemmes som legal_name.
        if (d && (d.unit_name || d.cvr)) hits = [{
            name: d.unit_name || (d.legal && d.legal.name) || '',
            cvr: d.cvr, ean: d.ean,
            legal_name: d.legal ? d.legal.name : null,
            status: d.legal ? 'juridisk enhed: ' + d.legal.name : 'EAN ' + d.ean,
        }];
    } else if (digits.length === 8 && digits === q.replace(/\s/g, '')) {
        const d = await tryUrl('/api/cvr/' + digits);
        if (d && (d.name || d.cvr)) hits = [d];
    } else {
        hits = (await tryUrl('/api/cvr/search?q=' + encodeURIComponent(q)))
            || (await tryUrl('/api/cvr/virk-search?q=' + encodeURIComponent(q)))
            || [];
        if (!Array.isArray(hits)) hits = [];
    }
    btn.disabled = false; btn.textContent = 'Søg';

    // Fra EAN-/CVR-feltet: ét entydigt hit udfyldes direkte, så man ikke først
    // skal klikke på det man lige har tastet. Flere hits (navnesøgning) vises.
    if (opts.autoApply && hits.length === 1) { cfApplyCvr(hits[0]); out.hidden = true; return; }

    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const rows = hits.map((r, i) => {
        const meta = [r.cvr ? 'CVR ' + r.cvr : null, [r.zipcode, r.city].filter(Boolean).join(' '), r.status].filter(Boolean).join('  ·  ');
        return `<button type="button" class="cf-new-cvr-hit" data-i="${i}"><span class="cf-new-cvr-hit-name">${esc(r.name || '(uden navn)')}</span>${meta ? `<span class="cf-new-cvr-hit-meta">${esc(meta)}</span>` : ''}</button>`;
    }).join('');
    // Registret er ikke altid til at søge i (et datterselskab kan hedde noget
    // andet end det kunden skriver under) — udvejen til Virk skal stå der.
    // Ved et EAN-opslag kan Virk ikke søge på tallet (set i drift: "0 resultater"),
    // så linket bruger det fundne CVR, og NemHandelsregistret får sit eget link.
    const isEan = digits.length === 13 && digits === q.replace(/\s/g, '');
    const virkQ = isEan ? (hits[0] && hits[0].cvr) : q;
    const virk = (virkQ
        ? `<a class="cf-new-cvr-virk" href="https://datacvr.virk.dk/soegeresultater?fritekst=${encodeURIComponent(virkQ)}" target="_blank" rel="noopener">Søg videre på datacvr.virk.dk${isEan ? ' (CVR ' + esc(virkQ) + ')' : ''} ↗</a>`
        : '')
      + (isEan
        ? `<a class="cf-new-cvr-virk" href="https://registration.nemhandel.dk/NemHandelRegisterWeb/public/participant/info?keytype=GLN&key=${encodeURIComponent(digits)}&lang=da" target="_blank" rel="noopener">Se EAN i NemHandelsregistret ↗</a>`
        : '');
    out.innerHTML = (rows || '<div class="cf-new-cvr-empty">Ingen match i CVR.</div>') + virk;
    out.querySelectorAll('.cf-new-cvr-hit').forEach(el => el.addEventListener('click', () => cfApplyCvr(hits[+el.dataset.i])));
}

function cfApplyCvr(r) {
    const $ = (id) => document.getElementById(id);
    if (r.name) $('cfn-name').value = r.name;
    if (r.cvr) $('cfn-cvr').value = r.cvr;
    if (r.ean) $('cfn-ean').value = r.ean;
    _cfNew.legalName = r.legal_name || null;
    if (r.phone && !$('cfn-phone').value) $('cfn-phone').value = r.phone;
    if (r.email && !$('cfn-email').value) $('cfn-email').value = r.email;
    // Adressen fra CVR gemmes som fallback — DAWA-valget vinder hvis der vælges ét.
    _cfNew.cvrAddress = r.address ? { address: r.address, zipcode: r.zipcode || '', city: r.city || '' } : null;
    if (r.address && !_cfNew.dawa) {
        $('cfn-dawa').value = [r.address, [r.zipcode, r.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    }
    $('cfn-cvr-results').hidden = true;
    _cfNew.confirmedMatchId = null; $('cfn-match').hidden = true;
}

function cfBindDawa() {
    const input = document.getElementById('cfn-dawa');
    const results = document.getElementById('cfn-dawa-results');
    const selected = document.getElementById('cfn-dawa-selected');
    let timer = null;
    input.addEventListener('input', () => {
        clearTimeout(timer);
        _cfNew.dawa = null;
        const q = input.value.trim();
        if (q.length < 3 || typeof dawaAutocomplete !== 'function') { results.hidden = true; return; }
        timer = setTimeout(async () => {
            try {
                const data = await dawaAutocomplete(q);
                if (!data.length) { results.hidden = true; return; }
                results.innerHTML = data.map((it, i) => `<div class="cf-new-dawa-item" data-i="${i}">${it.tekst}</div>`).join('');
                results.hidden = false;
                results.querySelectorAll('.cf-new-dawa-item').forEach(el => el.addEventListener('click', () => {
                    const it = data[+el.dataset.i];
                    // Autocomplete-elementet bærer de flade felter på .adresse (x = lon, y = lat).
                    const a = it.adresse || {};
                    _cfNew.dawa = {
                        street_name: a.vejnavn || '', street_nr: a.husnr || '',
                        postal_code: a.postnr || '', city: a.postnrnavn || '',
                        lat: a.y != null ? Number(a.y) : null, lon: a.x != null ? Number(a.x) : null,
                        label: it.tekst,
                    };
                    input.value = it.tekst;
                    results.hidden = true;
                    selected.hidden = false;
                    selected.textContent = '✓ ' + it.tekst;
                }));
            } catch (err) { console.warn('[cf] DAWA:', err.message); }
        }, 300);
    });
    document.addEventListener('click', (e) => {
        if (typeof clickedOutside === 'function' ? clickedOutside(e, input, results) : !results.contains(e.target)) results.hidden = true;
    });
}

/** Adresse-række til POST /api/companies: DAWA-valget først, ellers CVR's adresse. */
async function cfResolveAddressId() {
    if (_cfNew.dawa && _cfNew.dawa.street_name) {
        const r = await createAddress(_cfNew.dawa);
        return r.id;
    }
    const c = _cfNew.cvrAddress;
    if (c && c.address) {
        const m = c.address.match(/^(.+?)\s+(\d+\S*)$/);
        const r = await createAddress({
            street_name: m ? m[1] : c.address, street_nr: m ? m[2] : null,
            postal_code: c.zipcode || null, city: c.city || null,
        });
        return r.id;
    }
    return null;
}

async function cfSubmitNewFirma() {
    const $ = (id) => document.getElementById(id);
    const errEl = $('cfn-error'); errEl.hidden = true;
    const name = $('cfn-name').value.trim();
    const cvr = $('cfn-cvr').value.replace(/\D/g, '');
    const ean = $('cfn-ean').value.replace(/\s/g, '');
    const phone = $('cfn-phone').value.trim();
    const email = $('cfn-email').value.trim();
    const notes = $('cfn-notes').value.trim();
    const fail = (msg) => { errEl.textContent = msg; errEl.hidden = false; };

    if (!name) { fail('Firmanavn er påkrævet.'); $('cfn-name').focus(); return; }
    if (cvr && cvr.length !== 8) { fail('CVR skal være 8 cifre.'); $('cfn-cvr').focus(); return; }
    if (ean && !/^\d{13}$/.test(ean)) { fail('EAN skal være 13 cifre.'); $('cfn-ean').focus(); return; }

    const submit = $('cfn-submit');
    submit.disabled = true;
    try {
        // 1. Findes det allerede? Spørges hver gang, medmindre kontoret netop har
        //    sagt "opret alligevel" til PRÆCIS dette match.
        const { match } = await matchCompanyLookup({ name, cvr, ean, email });
        if (match && _cfNew.confirmedMatchId !== match.company_id) {
            cfShowMatch(match);
            submit.disabled = false;
            return;
        }
        // 2. Adresse (valgfri), så firma.
        const address_id = await cfResolveAddressId();
        const res = await createCompany({ name, cvr: cvr || null, ean: ean || null, phone: phone || null, email: email || null, notes: notes || null, address_id, legal_name: _cfNew.legalName });
        closeModal();
        if (typeof window.openFirma360 === 'function') window.openFirma360(res.id);
        else cfLoad();
    } catch (err) {
        fail('Kunne ikke oprette: ' + (err.message || 'ukendt fejl'));
        submit.disabled = false;
    }
}

function cfShowMatch(m) {
    const box = document.getElementById('cfn-match');
    const how = { cvr_exact: 'samme CVR', ean_exact: 'samme EAN', email_match: 'samme e-mail', name_fuzzy: 'lignende navn' }[m.match_type] || m.match_type;
    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const meta = [m.cvr ? 'CVR ' + m.cvr : null, [m.postal_code, m.city].filter(Boolean).join(' '), `${m.bons} bon${m.bons === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
    // "Samme CVR" er ikke "samme firma" når CVR'et deles af mange afdelinger.
    const shared = m.cvr_shared > 1
        ? `<div class="cf-new-match-meta">${m.cvr_shared} firmaer deler dette CVR — afdelinger er separate firmaer, så et nyt kan godt være rigtigt</div>`
        : '';
    box.hidden = false;
    box.innerHTML = `
        <div class="cf-new-match-title">Findes allerede? <strong>${esc(m.name)}</strong> <span class="cf-new-match-how">(${esc(how)})</span></div>
        <div class="cf-new-match-meta">${esc(meta)}</div>${shared}
        <div class="cf-new-match-actions">
            <button type="button" class="cf-new-mini" id="cfn-match-open">Åbn ${esc(m.name)}</button>
            <button type="button" class="cf-new-mini cf-new-mini-ghost" id="cfn-match-anyway">Opret alligevel</button>
        </div>`;
    document.getElementById('cfn-match-open').addEventListener('click', () => {
        closeModal();
        if (typeof window.openFirma360 === 'function') window.openFirma360(m.company_id);
    });
    document.getElementById('cfn-match-anyway').addEventListener('click', () => {
        _cfNew.confirmedMatchId = m.company_id;
        box.hidden = true;
        cfSubmitNewFirma();
    });
}

async function cfLoad() {
    const listEl = document.getElementById('cf-list');
    const statusEl = document.getElementById('cf-status');
    if (!listEl) return;

    _cfState.loading = true;
    statusEl.textContent = 'Henter firmaer…';
    statusEl.className = 'cf-status loading';

    try {
        const params = { limit: 100 };
        if (_cfState.stage !== 'all') params.stage = _cfState.stage;
        if (_cfState.q) params.q = _cfState.q;

        const rows = await fetchCrmCompanies(params);
        _cfState.companies = rows;
        cfRender(rows);
        statusEl.textContent = rows.length + ' firmaer';
        statusEl.className = 'cf-status';
    } catch (err) {
        console.error('crm-firmaer load failed:', err);
        statusEl.textContent = 'Fejl: ' + err.message;
        statusEl.className = 'cf-status error';
    } finally {
        _cfState.loading = false;
    }
}

function cfRender(rows) {
    const listEl = document.getElementById('cf-list');
    if (!rows || rows.length === 0) {
        listEl.innerHTML = `<div class="cf-empty">Ingen firmaer fundet.</div>`;
        return;
    }

    listEl.innerHTML = rows.map(co => {
        const stage = co.aggregated_stage || 'active';
        const stageLabel = stage === 'vip' ? '⭐ VIP'
                         : stage === 'dormant' ? 'Sovende' : 'Aktiv';
        const lastOrder = co.last_order_date
            ? `Senest: ${cfFormatDate(co.last_order_date)}`
            : 'Ingen ordrer';
        const enrichedNote = co.last_enriched_at
            ? `<span class="cf-enriched" title="Sidst beriget ${co.last_enriched_at}">⟳</span>`
            : '';
        const legalNote = co.legal_name && co.legal_name !== co.name
            ? `<div class="cf-legal">${escapeHtml(co.legal_name)}</div>`
            : '';
        const cvrCell = co.cvr ? `<span class="cf-cvr">CVR ${co.cvr}</span>` : '<span class="cf-cvr-empty">— uden CVR —</span>';

        const isChecked = _cfState.selected.has(co.id) ? 'checked' : '';
        return `
            <div class="cf-row" data-company-id="${co.id}">
                <input type="checkbox" class="cf-row-check" ${isChecked} data-company-id="${co.id}">
                <div class="cf-main">
                    <div class="cf-name-row">
                        <span class="cf-name">${escapeHtml(co.name)}</span>
                        ${co.flag_count > 0 ? `<span class="cf-flag-badge" title="${co.flag_count} påmindels${co.flag_count === 1 ? 'e' : 'er'} på firmaet">🚩${co.flag_count > 1 ? co.flag_count : ''}</span>` : ''}
                        ${enrichedNote}
                        <span class="cf-stage cf-stage-${stage}">${stageLabel}</span>
                    </div>
                    ${legalNote}
                    <div class="cf-meta">
                        <span class="cf-id" title="Firma-id (brug til sammenlægning)">#${co.id}</span>
                        <span class="cf-sep">·</span>
                        ${cvrCell}
                        <span class="cf-sep">·</span>
                        <span>${co.contact_count} kontakt${co.contact_count === 1 ? '' : 'er'}</span>
                    </div>
                </div>
                <div class="cf-stats">
                    <div class="cf-stat-row">
                        <span class="cf-stat-num">${co.total_orders}</span>
                        <span class="cf-stat-lbl">bons</span>
                    </div>
                    <div class="cf-stat-row">
                        <span class="cf-stat-num">${formatKr(co.total_revenue)}</span>
                        <span class="cf-stat-lbl">omsætning</span>
                    </div>
                </div>
                <div class="cf-trail">
                    <div class="cf-last">${lastOrder}</div>
                </div>
            </div>
        `;
    }).join('');

    // Klik på række = naviger til Firma 360°. Klik på checkbox = stopPropagation + toggle.
    listEl.querySelectorAll('.cf-row-check').forEach(cb => {
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', (e) => {
            const cid = parseInt(e.target.dataset.companyId, 10);
            cfToggleSelect(cid, e.target.checked);
        });
    });
    listEl.querySelectorAll('.cf-row').forEach(el => {
        el.addEventListener('click', (e) => {
            // Lad checkbox-klik passere uden navigation
            if (e.target.closest('.cf-row-check')) return;
            const companyId = parseInt(el.dataset.companyId, 10);
            if (typeof window.openFirma360 === 'function') {
                window.openFirma360(companyId);
            } else {
                console.warn('openFirma360 ikke defineret');
            }
        });
    });

    cfRenderSelectBar();
}

// Fase 2: multi-select handlers
function cfToggleSelect(companyId, checked) {
    if (checked) {
        const co = _cfState.companies.find(c => c.id === companyId);
        if (co) _cfState.selected.set(companyId, { id: co.id, name: co.name });
    } else {
        _cfState.selected.delete(companyId);
    }
    cfRenderSelectBar();
}

function cfSelectAll() {
    for (const co of _cfState.companies) {
        if (!_cfState.selected.has(co.id)) {
            _cfState.selected.set(co.id, { id: co.id, name: co.name });
        }
    }
    cfRender(_cfState.companies); // re-render checkboxes
}

function cfClearSelection() {
    _cfState.selected.clear();
    cfRender(_cfState.companies);
}

function cfOpenAddToCampaign() {
    if (typeof window.AddToCampaignModal?.open !== 'function') {
        alert('Modal ikke loadet');
        return;
    }
    window.AddToCampaignModal.open({
        companies: Array.from(_cfState.selected.values()),
        customers: [],
        onDone: () => cfClearSelection(),
    });
}

function cfRenderSelectBar() {
    const bar = document.getElementById('cf-select-bar');
    if (!bar) return;
    const count = _cfState.selected.size;
    if (count === 0) {
        bar.innerHTML = '';
        return;
    }
    bar.innerHTML = `
        <div class="cf-select-content">
            <span class="cf-select-count">${count} valgt</span>
            <button class="cf-select-btn cf-select-btn-primary" data-action="add">+ Tilføj til kampagne</button>
            <button class="cf-select-btn" data-action="all">Vælg alle på siden</button>
            <button class="cf-select-btn" data-action="clear">Ryd valg</button>
        </div>
    `;
    bar.querySelector('[data-action="add"]')?.addEventListener('click', cfOpenAddToCampaign);
    bar.querySelector('[data-action="all"]')?.addEventListener('click', cfSelectAll);
    bar.querySelector('[data-action="clear"]')?.addEventListener('click', cfClearSelection);
}

function cfEnsureSelectStyles() {
    if (document.getElementById('cf-select-styles')) return;
    const s = document.createElement('style');
    s.id = 'cf-select-styles';
    s.textContent = `
        .cf-row { align-items: center; }
        .cf-row-check {
            width: 16px; height: 16px; margin-right: 12px;
            accent-color: var(--brand-primary, #8e631f); cursor: pointer; flex-shrink: 0;
        }
        .cf-select-content {
            display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
            margin: 10px 0; padding: 10px 14px; border-radius: 10px;
            background: var(--brand-primary-light, #f1e6b2);
            border: 1px solid color-mix(in srgb, var(--brand-primary, #8e631f) 30%, transparent);
            font-size: 13px;
        }
        .cf-select-count { font-weight: 700; color: var(--brand-primary, #8e631f); }
        .cf-select-btn {
            padding: 6px 12px; border-radius: 6px; border: 1px solid var(--color-border, #d7d1ca);
            background: var(--color-surface, #fff); font-size: 13px; cursor: pointer;
            font-family: inherit;
        }
        .cf-select-btn:hover { filter: brightness(0.97); }
        .cf-select-btn-primary {
            background: var(--brand-primary, #8e631f); color: #fff; border-color: transparent;
            font-weight: 600;
        }
        .cf-select-btn-primary:hover { filter: brightness(1.08); }
    `;
    document.head.appendChild(s);
}

function cfFormatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('da-DK', { day: '2-digit', month: 'short', year: 'numeric' });
}

function cleanupCrmFirmaer() {
    if (_cfState.debounceTimer) clearTimeout(_cfState.debounceTimer);
    _cfState = {
        container: null, companies: [], stage: 'all', q: '',
        loading: false, debounceTimer: null,
        selected: new Map(),
    };
}

window.initCrmFirmaer = initCrmFirmaer;
window.cleanupCrmFirmaer = cleanupCrmFirmaer;
