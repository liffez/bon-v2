/**
 * office/views/crm-leadimport.js
 * ════════════════════════════════════════════════════════════
 * CRM → Importér leads — bulk-indlæsning af leads fra CSV/regneark.
 *
 * Flow:
 *   1. Upload .csv ELLER indsæt rækker fra Excel/Google Sheets.
 *   2. Parser detekterer skilletegn (tab / ; / ,) + overskriftsrække.
 *   3. Kolonne-mapping (auto-gæt fra headers, justerbar manuelt).
 *   4. "Forhåndsvis" → dry-run mod serveren (matcher uden at skrive).
 *   5. "Importér" → opretter/beriger firmaer + kontakter, sætter stage='lead'.
 *
 * Backend: POST /api/crm/leads/import (shared/api.js → importLeads()).
 * Matcher firma på CVR/navn og kontakt på email — opretter aldrig dubletter.
 * ════════════════════════════════════════════════════════════
 */

let _liState = {
    rawRows: [],      // parsed grid (array of arrays)
    hasHeader: true,
    mapping: {},      // colIndex → field-key
    allPrivate: false,
};

const _LI_FIELDS = [
    { key: '',             label: '— ignorér —' },
    { key: 'company_name', label: 'Firmanavn' },
    { key: 'cvr',          label: 'CVR' },
    { key: 'ean',          label: 'EAN' },
    { key: 'first_name',   label: 'Fornavn / Navn' },
    { key: 'last_name',    label: 'Efternavn' },
    { key: 'email',        label: 'Email' },
    { key: 'phone',        label: 'Telefon' },
    { key: 'notes',        label: 'Noter' },
];

function _liEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

/* ── CSS ───────────────────────────────────────────────────── */
function _liInjectStyles() {
    if (document.getElementById('li-styles')) return;
    const st = document.createElement('style');
    st.id = 'li-styles';
    st.textContent = `
    .li-wrap { max-width: 980px; }
    .li-wrap h2 { margin: 0 0 4px; }
    .li-lead { font-size: 13px; color: var(--color-text-dim); margin-bottom: 18px; max-width: 720px; line-height: 1.5; }
    .li-card { border: 1px solid var(--color-border); border-radius: 8px; padding: 16px 18px; margin-bottom: 16px; background: #fff; }
    .li-card h3 { font-size: 14px; font-weight: 600; margin: 0 0 10px; }
    .li-textarea { width: 100%; min-height: 130px; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: 6px; font-family: var(--font-mono, monospace); font-size: 12px; resize: vertical; box-sizing: border-box; }
    .li-row { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
    .li-or { color: var(--color-text-dim); font-size: 12px; font-weight: 600; }
    .li-btn { padding: 7px 16px; border: 1px solid var(--color-border); border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; background: var(--color-background); color: var(--color-text); font-family: var(--font-body); transition: background .15s, opacity .15s; }
    .li-btn:hover { background: var(--color-border); }
    .li-btn-primary { background: var(--brand-primary); color: #fff; border-color: var(--brand-primary); }
    .li-btn-primary:hover { opacity: .9; background: var(--brand-primary); }
    .li-btn:disabled { opacity: .5; cursor: not-allowed; }
    .li-map-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
    .li-map-col { border: 1px solid var(--color-border); border-radius: 6px; padding: 8px 10px; background: var(--color-background); }
    .li-map-sample { font-size: 11px; color: var(--color-text-dim); margin-bottom: 5px; min-height: 14px; word-break: break-word; }
    .li-map-col select { width: 100%; padding: 5px 6px; border: 1px solid var(--color-border); border-radius: 5px; font-size: 12px; }
    .li-opts { display: flex; gap: 20px; flex-wrap: wrap; align-items: center; margin: 12px 0; font-size: 13px; }
    .li-opts label { display: flex; gap: 6px; align-items: center; cursor: pointer; }
    .li-opts input[type="text"] { padding: 6px 10px; border: 1px solid var(--color-border); border-radius: 6px; font-size: 13px; }
    .li-tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    .li-tbl th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--color-text-dim); padding: 6px 8px; border-bottom: 1px solid var(--color-border); }
    .li-tbl td { padding: 6px 8px; border-bottom: 1px solid var(--color-border); vertical-align: top; }
    .li-tbl tr:last-child td { border-bottom: none; }
    .li-pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
    .li-pill-new { background: #e3f0e6; color: #1f4d28; }
    .li-pill-match { background: #e6eef3; color: #3d6a87; }
    .li-pill-err { background: #f3e6e3; color: #8a4738; }
    .li-pill-skip { background: var(--color-background); color: var(--color-text-dim); }
    .li-summary { background: #e3f0e6; border: 1px solid #cfe2d4; border-radius: 8px; padding: 12px 16px; margin-bottom: 14px; font-size: 13px; color: #2f6e3f; }
    .li-summary strong { font-weight: 700; }
    .li-link { color: var(--brand-primary); cursor: pointer; text-decoration: none; }
    .li-link:hover { text-decoration: underline; }
    .li-tbl-wrap { max-height: 420px; overflow-y: auto; border: 1px solid var(--color-border); border-radius: 6px; }
    .li-err-msg { color: #b34234; font-size: 13px; margin-top: 8px; }
    `;
    document.head.appendChild(st);
}

/* ── Parsing ───────────────────────────────────────────────── */
function _liDetectDelim(text) {
    const first = (text.split(/\r?\n/).find(l => l.trim() !== '') || '');
    const tabs = (first.match(/\t/g) || []).length;
    const semis = (first.match(/;/g) || []).length;
    const commas = (first.match(/,/g) || []).length;
    if (tabs > 0) return '\t';
    if (semis >= commas && semis > 0) return ';';
    return ',';
}

function _liParse(text, delim) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += ch;
        } else {
            if (ch === '"') inQuotes = true;
            else if (ch === delim) { row.push(field); field = ''; }
            else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
            else if (ch === '\r') { /* skip */ }
            else field += ch;
        }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows
        .map(r => r.map(c => (c || '').trim()))
        .filter(r => r.some(c => c !== ''));
}

function _liLooksLikeHeader(cells) {
    const kw = /(firma|company|virksomhed|navn|name|kontakt|cvr|ean|gln|e-?mail|mail|tlf|telefon|phone|mobil|note|bem)/i;
    return cells.some(c => kw.test(c)) && !cells.some(c => /@/.test(c));
}

function _liGuessField(header) {
    const h = (header || '').toLowerCase();
    if (/cvr/.test(h)) return 'cvr';
    if (/ean|gln/.test(h)) return 'ean';
    if (/e-?mail|mail/.test(h)) return 'email';
    if (/tlf|telefon|phone|mobil/.test(h)) return 'phone';
    if (/firma|company|virksomhed/.test(h)) return 'company_name';
    if (/fornavn|first/.test(h)) return 'first_name';
    if (/efternavn|last|sidste/.test(h)) return 'last_name';
    if (/note|bem/.test(h)) return 'notes';
    if (/navn|name|kontakt/.test(h)) return 'first_name';
    return '';
}

/* ── Build API rows from grid + mapping ────────────────────── */
function _liBuildRows() {
    const { rawRows, hasHeader, mapping, allPrivate } = _liState;
    const dataRows = hasHeader ? rawRows.slice(1) : rawRows;
    const lastNameMapped = Object.values(mapping).includes('last_name');
    const out = [];
    for (const cells of dataRows) {
        const r = { is_private: allPrivate };
        for (const [idx, key] of Object.entries(mapping)) {
            if (!key) continue;
            const v = (cells[idx] || '').trim();
            if (v) r[key] = v;
        }
        // Split fuldt navn → fornavn/efternavn hvis efternavn ikke er kortlagt
        if (!lastNameMapped && r.first_name && /\s/.test(r.first_name)) {
            const parts = r.first_name.split(/\s+/);
            r.last_name = parts.pop();
            r.first_name = parts.join(' ');
        }
        // Skip helt tomme rækker
        if (r.company_name || r.email || r.first_name || r.cvr) out.push(r);
    }
    return out;
}

/* ── Entry ─────────────────────────────────────────────────── */
function initCrmLeadimport(container) {
    _liInjectStyles();
    _liState = { rawRows: [], hasHeader: true, mapping: {}, allPrivate: false };
    container.innerHTML = `
      <div class="li-wrap">
        <h2>Importér leads</h2>
        <p class="li-lead">
          Indlæs en liste af potentielle kunder på én gang. Upload en <strong>.csv</strong>-fil eller indsæt
          rækker direkte fra Excel/Google Sheets. Hver række bliver til et firma + en kontakt med stadie
          <strong>Lead</strong>. Eksisterende firmaer (match på CVR eller navn) og kontakter (match på email)
          genbruges — der oprettes ingen dubletter.
        </p>

        <div class="li-card">
          <h3>1 · Data</h3>
          <div class="li-row" style="margin-bottom:10px">
            <label class="li-btn" style="display:inline-block">
              📄 Vælg .csv-fil
              <input type="file" id="li-file" accept=".csv,text/csv,text/plain" style="display:none">
            </label>
            <span class="li-or">eller indsæt nedenfor</span>
          </div>
          <textarea class="li-textarea" id="li-paste" placeholder="Firma\tCVR\tNavn\tEmail\tTelefon
Eksempel ApS\t12345678\tAnne Hansen\tanne@eksempel.dk\t12345678"></textarea>
          <div class="li-row" style="margin-top:10px">
            <button class="li-btn li-btn-primary" id="li-parse-btn">Indlæs rækker →</button>
            <span id="li-parse-info" style="font-size:12px;color:var(--color-text-dim)"></span>
          </div>
        </div>

        <div id="li-step2" style="display:none"></div>
        <div id="li-result"></div>
      </div>
    `;

    container.querySelector('#li-file').addEventListener('change', _liOnFile);
    container.querySelector('#li-parse-btn').addEventListener('click', () => {
        const text = container.querySelector('#li-paste').value;
        _liIngest(text);
    });
}

function cleanupCrmLeadimport() {
    _liState = { rawRows: [], hasHeader: true, mapping: {}, allPrivate: false };
}

function _liOnFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        document.getElementById('li-paste').value = reader.result || '';
        _liIngest(reader.result || '');
    };
    reader.readAsText(file);
}

function _liIngest(text) {
    const info = document.getElementById('li-parse-info');
    if (!text || !text.trim()) { if (info) info.textContent = 'Indsæt data eller vælg en fil først.'; return; }
    const delim = _liDetectDelim(text);
    const rows = _liParse(text, delim);
    if (rows.length === 0) { if (info) info.textContent = 'Kunne ikke læse nogen rækker.'; return; }

    _liState.rawRows = rows;
    _liState.hasHeader = _liLooksLikeHeader(rows[0]);

    // Auto-gæt mapping
    const headerRow = rows[0];
    const mapping = {};
    const usedFields = new Set();
    headerRow.forEach((cell, idx) => {
        if (!_liState.hasHeader) return;
        const g = _liGuessField(cell);
        if (g && !usedFields.has(g)) { mapping[idx] = g; usedFields.add(g); }
        else mapping[idx] = '';
    });
    _liState.mapping = mapping;

    const delimName = delim === '\t' ? 'tab' : (delim === ';' ? 'semikolon' : 'komma');
    if (info) info.textContent = `${rows.length} rækker · skilletegn: ${delimName}`;
    _liRenderStep2();
}

function _liRenderStep2() {
    const el = document.getElementById('li-step2');
    const { rawRows, hasHeader, mapping } = _liState;
    const headerRow = rawRows[0] || [];
    const firstData = (hasHeader ? rawRows[1] : rawRows[0]) || [];
    const colCount = Math.max(...rawRows.map(r => r.length));

    let cols = '';
    for (let i = 0; i < colCount; i++) {
        const head = hasHeader ? (headerRow[i] || `Kolonne ${i + 1}`) : `Kolonne ${i + 1}`;
        const sample = firstData[i] || '';
        const sel = _LI_FIELDS.map(f =>
            `<option value="${f.key}" ${mapping[i] === f.key ? 'selected' : ''}>${_liEsc(f.label)}</option>`
        ).join('');
        cols += `
          <div class="li-map-col">
            <div style="font-size:12px;font-weight:600;margin-bottom:3px">${_liEsc(head)}</div>
            <div class="li-map-sample">${sample ? 'fx: ' + _liEsc(sample) : ''}</div>
            <select data-col="${i}">${sel}</select>
          </div>`;
    }

    const dataCount = hasHeader ? rawRows.length - 1 : rawRows.length;

    el.style.display = '';
    el.innerHTML = `
      <div class="li-card">
        <h3>2 · Kolonner</h3>
        <div class="li-opts">
          <label><input type="checkbox" id="li-header" ${hasHeader ? 'checked' : ''}> Første række er overskrifter</label>
          <label><input type="checkbox" id="li-private"> Importér alle som privatkunder (intet firma)</label>
        </div>
        <div class="li-map-grid">${cols}</div>
      </div>

      <div class="li-card">
        <h3>3 · Indstillinger</h3>
        <div class="li-opts">
          <label>Batch-mærkat (tag):
            <input type="text" id="li-tag" placeholder="fx Outreach juni 2026" style="width:220px">
          </label>
          <label><input type="checkbox" id="li-enrich"> Slå firmaer op i CVR/Virk undervejs (langsommere)</label>
        </div>
        <div class="li-row" style="margin-top:6px">
          <button class="li-btn" id="li-preview-btn">👁 Forhåndsvis (${dataCount} rækker)</button>
          <button class="li-btn li-btn-primary" id="li-import-btn" disabled>Importér</button>
          <span id="li-busy" style="font-size:12px;color:var(--color-text-dim)"></span>
        </div>
        <div id="li-preview-msg" class="li-err-msg" style="display:none"></div>
      </div>
    `;

    el.querySelectorAll('select[data-col]').forEach(s => {
        s.addEventListener('change', () => { _liState.mapping[parseInt(s.dataset.col, 10)] = s.value; });
    });
    el.querySelector('#li-header').addEventListener('change', e => {
        _liState.hasHeader = e.target.checked;
        _liRenderStep2();
    });
    el.querySelector('#li-private').addEventListener('change', e => { _liState.allPrivate = e.target.checked; });
    el.querySelector('#li-preview-btn').addEventListener('click', () => _liRun(true));
    el.querySelector('#li-import-btn').addEventListener('click', () => _liRun(false));
}

function _liValidateMapping() {
    const fields = Object.values(_liState.mapping);
    if (_liState.allPrivate) {
        if (!fields.includes('email') && !fields.includes('first_name'))
            return 'Privatkunde-import kræver mindst en Email- eller Navn-kolonne.';
    } else if (!fields.includes('company_name') && !fields.includes('cvr')) {
        return 'Vælg mindst en Firmanavn- eller CVR-kolonne (eller slå privatkunde-import til).';
    }
    return null;
}

async function _liRun(dryRun) {
    const busy = document.getElementById('li-busy');
    const msg = document.getElementById('li-preview-msg');
    const importBtn = document.getElementById('li-import-btn');
    msg.style.display = 'none';

    const mapErr = _liValidateMapping();
    if (mapErr) { msg.textContent = mapErr; msg.style.display = ''; return; }

    const rows = _liBuildRows();
    if (rows.length === 0) { msg.textContent = 'Ingen brugbare rækker fundet.'; msg.style.display = ''; return; }

    const tag = (document.getElementById('li-tag').value || '').trim();
    const enrich = document.getElementById('li-enrich').checked;

    busy.textContent = dryRun ? 'Tjekker…' : 'Importerer…';
    document.getElementById('li-preview-btn').disabled = true;
    importBtn.disabled = true;

    try {
        const resp = await importLeads({ rows, tag: tag || undefined, enrich, dry_run: dryRun });
        _liRenderResult(resp, dryRun);
        if (dryRun) {
            importBtn.disabled = false;
            importBtn.textContent = `✓ Importér ${rows.length} rækker`;
        } else {
            importBtn.textContent = 'Importeret';
        }
    } catch (err) {
        msg.textContent = 'Fejl: ' + err.message;
        msg.style.display = '';
    } finally {
        busy.textContent = '';
        document.getElementById('li-preview-btn').disabled = false;
    }
}

function _liRenderResult(resp, dryRun) {
    const el = document.getElementById('li-result');
    const s = resp.summary || {};
    const canOpen = typeof window.openKunde360 === 'function';

    const rowsHtml = (resp.rows || []).map(r => {
        let statusPill, detail = '';
        if (r.status === 'error') {
            statusPill = `<span class="li-pill li-pill-err">Fejl</span>`;
            detail = _liEsc(r.message || '');
        } else {
            const parts = [];
            if (r.company_action === 'create') parts.push('<span class="li-pill li-pill-new">Nyt firma</span>');
            else if (r.company_action === 'matched') parts.push(`<span class="li-pill li-pill-match">Firma #${r.company_id}</span>`);
            if (r.customer_action === 'create') parts.push('<span class="li-pill li-pill-new">Ny kontakt</span>');
            else parts.push(`<span class="li-pill li-pill-match">Kontakt #${r.customer_id}</span>`);
            if (r.enriched) parts.push('<span class="li-pill li-pill-skip">CVR ✓</span>');
            statusPill = parts.join(' ');
        }
        const custCell = (!dryRun && r.customer_id && canOpen)
            ? `<a class="li-link" data-cust="${r.customer_id}">#${r.customer_id} →</a>`
            : (r.customer_id ? '#' + r.customer_id : '');
        return `
          <tr>
            <td>${_liEsc(r.company_name || '—')}</td>
            <td>${custCell}</td>
            <td>${statusPill}${detail ? `<div style="color:#b34234;font-size:11px;margin-top:2px">${detail}</div>` : ''}</td>
          </tr>`;
    }).join('');

    const head = dryRun
        ? `<div class="li-summary" style="background:#e6eef3;border-color:#cfd9e3;color:#3d6a87">
             <strong>Forhåndsvisning</strong> · ${s.total} rækker ·
             ${s.errors > 0 ? `<strong style="color:#b34234">${s.errors} fejl</strong> · ` : ''}
             tryk <strong>Importér</strong> for at gennemføre.
           </div>`
        : `<div class="li-summary">
             <strong>✓ Import gennemført</strong> ·
             ${s.companies_created} nye firmaer · ${s.companies_enriched} berigede ·
             ${s.customers_created} nye kontakter · ${s.customers_matched} matchede ·
             ${s.leads_set} sat til lead${s.errors > 0 ? ` · <strong style="color:#b34234">${s.errors} fejl</strong>` : ''}
           </div>`;

    el.innerHTML = `
      ${head}
      <div class="li-card">
        <div class="li-tbl-wrap">
          <table class="li-tbl">
            <thead><tr><th>Firma</th><th>Kontakt</th><th>Status</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>
    `;

    if (!dryRun && canOpen) {
        el.querySelectorAll('a.li-link[data-cust]').forEach(a => {
            a.addEventListener('click', () => window.openKunde360(parseInt(a.dataset.cust, 10)));
        });
    }
}
