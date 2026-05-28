/**
 * office/views/campaign-import.js
 * ════════════════════════════════════════════════════════════
 * Paste-import af firmaer til en outreach-kampagne.
 *
 * Flow:
 *   1. Paste tab-separeret data fra Excel (eller CSV/semikolon)
 *   2. Auto-detect header-række + foreslå kolonne-mapping
 *   3. Bruger justerer mapping (gemmes i localStorage)
 *   4. Preview: server matcher hver række mod eksisterende firmaer
 *   5. Bruger godkender/justerer per-række beslutning
 *   6. Commit: alt i én transaktion på server
 *
 * Modal/overlay-baseret — vises som drawer fra højre når brugeren
 * klikker "📋 Importér" på pipeline-boardet for en specifik kampagne.
 *
 * Spec: docs/CLAUDE_OUTREACH_KAMPAGNER.md Fase 3.
 * ════════════════════════════════════════════════════════════
 */

(function () {
    'use strict';

    const MAPPING_KEY = 'bon_v2_campaign_import_mapping_v1';
    const COLUMN_OPTIONS = [
        { value: '__ignore__', label: 'Ignorér' },
        { value: 'name',            label: 'Firmanavn' },
        { value: 'cvr',             label: 'CVR' },
        { value: 'ean',             label: 'EAN' },
        { value: 'contact_person',  label: 'Kontaktperson' },
        { value: 'email',           label: 'E-mail' },
        { value: 'phone',           label: 'Telefon' },
        { value: 'address',         label: 'Adresse' },
        { value: 'city',            label: 'By' },
        { value: 'postcode',        label: 'Postnr' },
        { value: 'notes',           label: 'Noter' },
    ];

    // Heuristik: matcher header-cellestekst → COLUMN_OPTIONS.value
    function _autoDetect(header) {
        const h = String(header || '').toLowerCase().trim();
        if (!h) return '__ignore__';
        if (/^(firma|virksomhed|company|navn$)/i.test(h)) return 'name';
        if (/^cvr/i.test(h)) return 'cvr';
        if (/^ean|gln/i.test(h)) return 'ean';
        if (/(kontakt|attention|att\.?|navn)/i.test(h) && !h.match(/^firmanavn/i)) return 'contact_person';
        if (/^e[\-\s]?mail|mail/i.test(h)) return 'email';
        if (/(tlf|telefon|phone|mobil)/i.test(h)) return 'phone';
        if (/(adresse|vejnavn|gade)/i.test(h)) return 'address';
        if (/^by$|^by\b|city/i.test(h)) return 'city';
        if (/(postnr|postnummer|zip|postal)/i.test(h)) return 'postcode';
        if (/(note|kommentar|comment|bemærkning)/i.test(h)) return 'notes';
        return '__ignore__';
    }

    function _esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[ch]));
    }

    function _ensureStyles() {
        if (document.getElementById('ci-styles')) return;
        const style = document.createElement('style');
        style.id = 'ci-styles';
        style.textContent = `
            .ci-overlay {
                position: fixed; inset: 0; background: rgba(0,0,0,0.45);
                z-index: 9999; display: flex; align-items: stretch; justify-content: flex-end;
                font-family: var(--font-body, 'DM Sans', system-ui, sans-serif);
            }
            .ci-drawer {
                background: var(--color-surface, #fff);
                width: min(900px, 92vw); height: 100vh; overflow: hidden;
                display: flex; flex-direction: column;
                box-shadow: -10px 0 30px rgba(0,0,0,0.18);
                animation: ci-slide-in .18s ease-out;
            }
            @keyframes ci-slide-in {
                from { transform: translateX(100%); }
                to   { transform: translateX(0); }
            }
            .ci-header {
                padding: 18px 24px; border-bottom: 1px solid var(--color-border, #e7e2db);
                display: flex; justify-content: space-between; align-items: center;
                flex-shrink: 0;
            }
            .ci-title {
                font-family: var(--font-heading, 'Playfair Display', Georgia, serif);
                font-size: 20px; font-weight: 700; margin: 0;
            }
            .ci-sub {
                font-size: 12px; color: var(--color-text-dim, #888);
                margin-top: 2px;
            }
            .ci-close {
                background: none; border: none; font-size: 24px; cursor: pointer;
                color: var(--color-text-dim, #888); padding: 0; line-height: 1;
            }
            .ci-body { flex: 1; overflow-y: auto; padding: 20px 24px; }
            .ci-footer {
                padding: 14px 24px; border-top: 1px solid var(--color-border, #e7e2db);
                display: flex; justify-content: space-between; align-items: center;
                gap: 10px; flex-shrink: 0;
                background: var(--color-surface-alt, #fafaf7);
            }
            .ci-footer-actions { display: flex; gap: 10px; }
            .ci-btn {
                padding: 9px 18px; border-radius: 8px; border: none;
                font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit;
            }
            .ci-btn-cancel { background: transparent; color: var(--color-text-dim, #555); }
            .ci-btn-cancel:hover { color: var(--color-text, #333); }
            .ci-btn-primary { background: var(--brand-primary, #8e631f); color: #fff; }
            .ci-btn-primary:hover { filter: brightness(1.08); }
            .ci-btn-primary:disabled { background: var(--color-border, #d7d1ca); cursor: not-allowed; }
            .ci-btn-secondary {
                background: var(--color-surface, #fff); color: var(--color-text, #333);
                border: 1px solid var(--color-border, #d7d1ca);
            }
            .ci-btn-secondary:hover { background: var(--color-surface-alt, #fafaf7); }

            .ci-step-tabs {
                display: flex; gap: 0; border-bottom: 2px solid var(--color-border, #e7e2db);
                margin: -20px -24px 20px;
                padding: 0 24px;
            }
            .ci-step {
                padding: 10px 16px; font-size: 13px; font-weight: 600;
                color: var(--color-text-dim, #888); border-bottom: 2px solid transparent;
                margin-bottom: -2px;
            }
            .ci-step.active {
                color: var(--brand-primary, #8e631f);
                border-bottom-color: var(--brand-primary, #8e631f);
            }
            .ci-step.done { color: #2c7a3d; }

            .ci-textarea {
                width: 100%; min-height: 280px;
                padding: 12px; font-size: 13px;
                font-family: 'SF Mono', Menlo, Consolas, monospace;
                border: 1px solid var(--color-border, #d7d1ca);
                border-radius: 8px; resize: vertical;
                box-sizing: border-box;
            }
            .ci-hint {
                font-size: 12px; color: var(--color-text-dim, #888);
                margin-top: 6px;
            }
            .ci-error {
                background: #fdecea; color: #a13d2e;
                padding: 10px 14px; border-radius: 8px;
                font-size: 13px; margin-bottom: 12px;
            }
            .ci-info {
                background: var(--brand-primary-light, #f1e6b2);
                color: var(--brand-primary, #8e631f);
                padding: 10px 14px; border-radius: 8px;
                font-size: 13px; margin-bottom: 12px;
            }

            /* Mapping-trin */
            .ci-mapping-table {
                width: 100%; border-collapse: collapse; margin-top: 10px;
            }
            .ci-mapping-table th, .ci-mapping-table td {
                padding: 8px 10px; text-align: left;
                border-bottom: 1px solid var(--color-border, #e7e2db);
                font-size: 13px;
            }
            .ci-mapping-table th {
                background: var(--color-surface-alt, #fafaf7);
                font-weight: 600; color: var(--color-text-dim);
                text-transform: uppercase; font-size: 11px; letter-spacing: .04em;
            }
            .ci-mapping-select {
                padding: 6px 10px; border-radius: 6px;
                border: 1px solid var(--color-border, #d7d1ca);
                font-size: 13px; font-family: inherit;
                background: var(--color-surface, #fff);
            }
            .ci-mapping-sample {
                color: var(--color-text-dim, #888); font-size: 12px;
                max-width: 280px; overflow: hidden; text-overflow: ellipsis;
                white-space: nowrap;
            }
            .ci-header-toggle {
                display: flex; align-items: center; gap: 8px;
                margin: 10px 0; font-size: 13px; cursor: pointer;
            }
            .ci-header-toggle input { accent-color: var(--brand-primary, #8e631f); }

            /* Preview-trin */
            .ci-summary {
                display: flex; gap: 14px; flex-wrap: wrap;
                margin-bottom: 14px;
            }
            .ci-summary-card {
                padding: 8px 14px; border-radius: 8px;
                background: var(--color-surface-alt, #fafaf7);
                font-size: 13px;
            }
            .ci-summary-num { font-weight: 700; }
            .ci-bulk {
                display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px;
            }
            .ci-bulk-btn {
                padding: 5px 10px; border-radius: 6px;
                border: 1px solid var(--color-border, #d7d1ca);
                background: var(--color-surface, #fff);
                font-size: 12px; cursor: pointer; font-family: inherit;
            }
            .ci-bulk-btn:hover { background: var(--brand-primary-light, #f1e6b2); }

            .ci-preview-table {
                width: 100%; border-collapse: collapse;
                font-size: 13px;
            }
            .ci-preview-table th, .ci-preview-table td {
                padding: 8px; border-bottom: 1px solid var(--color-border, #e7e2db);
                vertical-align: top;
            }
            .ci-preview-table th {
                background: var(--color-surface-alt, #fafaf7);
                text-align: left; font-weight: 600; color: var(--color-text-dim);
                text-transform: uppercase; font-size: 11px; letter-spacing: .04em;
                position: sticky; top: 0;
            }
            .ci-preview-row[data-action="skip"] { background: #fafaf7; opacity: 0.7; }
            .ci-preview-row[data-action="use_existing"] { background: #f0f7ec; }
            .ci-preview-row[data-action="create_new"]   { background: #e9f1f8; }
            .ci-preview-row[data-action="review"]       { background: #fff7e0; }
            .ci-action-badge {
                display: inline-block; padding: 2px 8px; border-radius: 10px;
                font-size: 10px; font-weight: 600; text-transform: uppercase;
                letter-spacing: .04em;
            }
            .ci-action-use_existing { background: #d8e8cf; color: #2c5a23; }
            .ci-action-create_new   { background: #d4e2f0; color: #1e4d7a; }
            .ci-action-review       { background: #f3e3a2; color: #7a5a1a; }
            .ci-action-skip         { background: #e0dcd5; color: #555; }
            .ci-conf-bar {
                display: inline-block; width: 60px; height: 6px;
                background: var(--color-border, #e7e2db); border-radius: 3px;
                vertical-align: middle; margin-right: 6px;
            }
            .ci-conf-fill {
                display: block; height: 100%; border-radius: 3px;
                background: var(--brand-primary, #8e631f);
            }
            .ci-action-select {
                padding: 4px 8px; border-radius: 6px;
                border: 1px solid var(--color-border, #d7d1ca);
                font-size: 12px; background: var(--color-surface, #fff);
                font-family: inherit;
            }
        `;
        document.head.appendChild(style);
    }

    // Parse paste-tekst: tab-separeret eller semikolon (DK CSV) eller komma
    function _parsePaste(text) {
        const lines = text.split(/\r?\n/).map(l => l).filter((l, i, arr) => l.length > 0 || i < arr.length - 1);
        const trimmed = lines.filter(l => l.trim().length > 0);
        if (trimmed.length === 0) return [];

        // Detect separator: tab > semikolon > komma (i prioriteret rækkefølge)
        const firstLine = trimmed[0];
        const sep = firstLine.includes('\t') ? '\t'
            : firstLine.includes(';') ? ';'
            : firstLine.includes(',') ? ','
            : '\t';
        return trimmed.map(line => line.split(sep).map(c => c.trim()));
    }

    // Heuristik: hvis første række ser ud som header (har ingen tal-only celler, har feltnavne)
    function _looksLikeHeader(cells) {
        if (!cells || cells.length === 0) return false;
        // Hvis ingen celler er rene tal og mindst én matcher en feltnavn-heuristik
        let matchedFieldNames = 0;
        let numericCells = 0;
        for (const c of cells) {
            if (/^\d+([\.,]\d+)?$/.test(c.trim())) numericCells++;
            if (_autoDetect(c) !== '__ignore__') matchedFieldNames++;
        }
        return matchedFieldNames >= 1 && numericCells === 0;
    }

    let _state = null;

    function _loadSavedMapping() {
        try {
            const raw = localStorage.getItem(MAPPING_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    }
    function _saveMapping(mapping) {
        try { localStorage.setItem(MAPPING_KEY, JSON.stringify(mapping)); }
        catch { /* quota */ }
    }

    function _open(opts) {
        _ensureStyles();
        _state = {
            campaignId: opts.campaignId,
            campaignName: opts.campaignName,
            step: 'paste',     // 'paste' | 'mapping' | 'preview' | 'done'
            rawText: '',
            rows: [],          // string[][]
            hasHeader: false,
            mapping: [],       // pr. kolonne: column-value string
            preview: null,     // server-response
            decisions: [],     // pr. preview-row
            busy: false,
            onDone: opts.onDone || null,
        };

        const overlay = document.createElement('div');
        overlay.className = 'ci-overlay';
        overlay.innerHTML = `
            <div class="ci-drawer" role="dialog" aria-modal="true">
                <div class="ci-header">
                    <div>
                        <h2 class="ci-title">Importér til kampagne</h2>
                        <div class="ci-sub">${_esc(opts.campaignName || '')}</div>
                    </div>
                    <button class="ci-close" id="ci-close" aria-label="Luk">×</button>
                </div>
                <div class="ci-body" id="ci-body"></div>
                <div class="ci-footer" id="ci-footer"></div>
            </div>
        `;
        document.body.appendChild(overlay);
        _state.overlay = overlay;

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay && !_state.busy) _close();
        });
        document.getElementById('ci-close').addEventListener('click', () => { if (!_state.busy) _close(); });
        document.addEventListener('keydown', _onEscape);

        _renderStep();
    }

    function _close() {
        if (_state?.overlay) _state.overlay.remove();
        document.removeEventListener('keydown', _onEscape);
        _state = null;
    }
    function _onEscape(e) {
        if (e.key === 'Escape' && _state && !_state.busy) _close();
    }

    function _renderStep() {
        const body = document.getElementById('ci-body');
        const footer = document.getElementById('ci-footer');
        if (!body || !footer) return;

        const tabs = `
            <div class="ci-step-tabs">
                <span class="ci-step ${_state.step === 'paste' ? 'active' : (_state.rows.length ? 'done' : '')}">1. Indsæt</span>
                <span class="ci-step ${_state.step === 'mapping' ? 'active' : (_state.preview ? 'done' : '')}">2. Mapping</span>
                <span class="ci-step ${_state.step === 'preview' ? 'active' : (_state.step === 'done' ? 'done' : '')}">3. Bekræft</span>
            </div>
        `;

        if (_state.step === 'paste') _renderPaste(body, footer, tabs);
        else if (_state.step === 'mapping') _renderMapping(body, footer, tabs);
        else if (_state.step === 'preview') _renderPreview(body, footer, tabs);
        else if (_state.step === 'done') _renderDone(body, footer, tabs);
    }

    // ─── Step 1: Indsæt ─────────────────────────────────────────

    function _renderPaste(body, footer, tabs) {
        body.innerHTML = `
            ${tabs}
            <p style="margin:0 0 10px 0;font-size:14px;">
                Indsæt rækker fra Excel (tab-separeret), CSV eller semikolon-separeret tekst.
            </p>
            <textarea class="ci-textarea" id="ci-textarea" placeholder="Firmanavn	CVR	E-mail	By
Magasin A/S	12345678	kontakt@magasin.dk	København
Bagerhuset I/S	87654321	post@bagerhuset.dk	Aarhus
..."></textarea>
            <div class="ci-hint">Op til 5000 rækker. Første række kan være header med kolonne-navne.</div>
        `;
        footer.innerHTML = `
            <div></div>
            <div class="ci-footer-actions">
                <button class="ci-btn ci-btn-cancel" id="ci-cancel">Annullér</button>
                <button class="ci-btn ci-btn-primary" id="ci-next">Næste →</button>
            </div>
        `;
        document.getElementById('ci-cancel').addEventListener('click', _close);
        document.getElementById('ci-next').addEventListener('click', () => {
            const text = document.getElementById('ci-textarea').value.trim();
            if (!text) return;
            const rows = _parsePaste(text);
            if (!rows.length) return;
            _state.rawText = text;
            _state.rows = rows;
            _state.hasHeader = _looksLikeHeader(rows[0]);
            // Auto-mapping: brug header hvis det er header, ellers prøv at gemte mapping
            const columnCount = Math.max(...rows.map(r => r.length));
            if (_state.hasHeader) {
                _state.mapping = rows[0].map(h => _autoDetect(h));
                while (_state.mapping.length < columnCount) _state.mapping.push('__ignore__');
            } else {
                const saved = _loadSavedMapping();
                _state.mapping = saved && saved.length >= columnCount
                    ? saved.slice(0, columnCount)
                    : Array(columnCount).fill('__ignore__');
            }
            _state.step = 'mapping';
            _renderStep();
        });
    }

    // ─── Step 2: Mapping ────────────────────────────────────────

    function _renderMapping(body, footer, tabs) {
        const columnCount = _state.mapping.length;
        const sampleRowIdx = _state.hasHeader ? 1 : 0;
        const sampleRow = _state.rows[sampleRowIdx] || [];

        const tableRows = Array.from({ length: columnCount }, (_, i) => {
            const headerCell = _state.hasHeader ? (_state.rows[0][i] || '') : `Kolonne ${i + 1}`;
            const sample = sampleRow[i] || '';
            const current = _state.mapping[i] || '__ignore__';
            const options = COLUMN_OPTIONS.map(opt =>
                `<option value="${opt.value}"${opt.value === current ? ' selected' : ''}>${_esc(opt.label)}</option>`
            ).join('');
            return `
                <tr>
                    <td>${_esc(headerCell)}</td>
                    <td class="ci-mapping-sample">${_esc(sample)}</td>
                    <td>
                        <select class="ci-mapping-select" data-col="${i}">${options}</select>
                    </td>
                </tr>
            `;
        }).join('');

        body.innerHTML = `
            ${tabs}
            <label class="ci-header-toggle">
                <input type="checkbox" id="ci-has-header" ${_state.hasHeader ? 'checked' : ''}>
                Første række er header
            </label>
            <p style="margin:0 0 8px 0;font-size:13px;color:var(--color-text-dim);">
                Vælg hvilket felt hver kolonne dækker. ${_state.rows.length - (_state.hasHeader ? 1 : 0)} datarækker indlæst.
            </p>
            <table class="ci-mapping-table">
                <thead><tr><th>Kolonne</th><th>Eksempel</th><th>Felt</th></tr></thead>
                <tbody>${tableRows}</tbody>
            </table>
        `;
        footer.innerHTML = `
            <div></div>
            <div class="ci-footer-actions">
                <button class="ci-btn ci-btn-secondary" id="ci-back">← Tilbage</button>
                <button class="ci-btn ci-btn-primary" id="ci-next">Forhåndsvis →</button>
            </div>
        `;

        document.getElementById('ci-has-header').addEventListener('change', (e) => {
            _state.hasHeader = e.target.checked;
            _renderStep();
        });
        body.querySelectorAll('.ci-mapping-select').forEach(sel => {
            sel.addEventListener('change', () => {
                const col = parseInt(sel.dataset.col);
                _state.mapping[col] = sel.value;
            });
        });
        document.getElementById('ci-back').addEventListener('click', () => {
            _state.step = 'paste';
            _renderStep();
        });
        document.getElementById('ci-next').addEventListener('click', _doPreview);
    }

    // ─── Konverter rows + mapping → objekter til server ─────────

    function _rowsToObjects() {
        const startIdx = _state.hasHeader ? 1 : 0;
        const out = [];
        for (let i = startIdx; i < _state.rows.length; i++) {
            const row = _state.rows[i];
            const obj = {};
            for (let c = 0; c < _state.mapping.length; c++) {
                const field = _state.mapping[c];
                if (field === '__ignore__') continue;
                const val = row[c];
                if (val == null || val === '') continue;
                obj[field] = val;
            }
            out.push(obj);
        }
        return out;
    }

    // ─── Step 3: Preview ────────────────────────────────────────

    async function _doPreview() {
        const rows = _rowsToObjects();
        if (rows.length === 0) {
            _state.preview = { rows: [], count: 0 };
            _state.decisions = [];
            _state.step = 'preview';
            _renderStep();
            return;
        }
        // Gem mapping til næste gang
        _saveMapping(_state.mapping);

        _state.busy = true;
        try {
            const r = await previewCampaignImport(_state.campaignId, rows);
            _state.preview = r;
            // Default-beslutninger: kopier suggested_action + behold input + match_company_id
            _state.decisions = r.rows.map(p => ({
                row_index: p.row_index,
                action: p.suggested_action,
                company_id: p.match_company_id,
                input: p.input,
                _match_name: p.match_company_name,
                _match_confidence: p.match_confidence,
                _already_member: p.already_member,
            }));
            _state.step = 'preview';
            _state.busy = false;
            _renderStep();
        } catch (err) {
            _state.busy = false;
            alert('Kunne ikke forhåndsvise: ' + (err.message || 'ukendt fejl'));
        }
    }

    function _renderPreview(body, footer, tabs) {
        const decisions = _state.decisions;
        const counts = decisions.reduce((acc, d) => { acc[d.action] = (acc[d.action] || 0) + 1; return acc; }, {});
        const totalAdds = (counts.use_existing || 0) + (counts.create_new || 0);

        const tableRows = decisions.map((d, i) => {
            const p = _state.preview.rows[i];
            const inputSummary = [p.input.name, p.input.cvr, p.input.email].filter(Boolean).join(' · ');
            const matchInfo = d.action === 'use_existing' || d.action === 'review'
                ? _renderMatchCell(d)
                : (d.action === 'create_new' ? '<em>Opretter nyt firma</em>'
                   : '<span style="color:var(--color-text-dim)">—</span>');

            return `
                <tr class="ci-preview-row" data-row-index="${p.row_index}" data-action="${d.action}">
                    <td>${p.row_index + 1}</td>
                    <td>${_esc(inputSummary || '(tom)')}</td>
                    <td>${matchInfo}</td>
                    <td>
                        <select class="ci-action-select" data-row-index="${p.row_index}">
                            ${p.match_company_id ? `<option value="use_existing"${d.action === 'use_existing' ? ' selected' : ''}>Brug eksisterende</option>` : ''}
                            ${p.input.name ? `<option value="create_new"${d.action === 'create_new' ? ' selected' : ''}>Opret nyt</option>` : ''}
                            <option value="skip"${d.action === 'skip' ? ' selected' : ''}>Spring over</option>
                        </select>
                    </td>
                </tr>
            `;
        }).join('');

        body.innerHTML = `
            ${tabs}
            <div class="ci-summary">
                <div class="ci-summary-card">📊 <span class="ci-summary-num">${decisions.length}</span> rækker</div>
                <div class="ci-summary-card" style="background:#f0f7ec;">✓ <span class="ci-summary-num">${counts.use_existing || 0}</span> brug eksisterende</div>
                <div class="ci-summary-card" style="background:#e9f1f8;">＋ <span class="ci-summary-num">${counts.create_new || 0}</span> opret nye</div>
                <div class="ci-summary-card" style="background:#fff7e0;">? <span class="ci-summary-num">${counts.review || 0}</span> kræver review</div>
                <div class="ci-summary-card">⊘ <span class="ci-summary-num">${counts.skip || 0}</span> springes over</div>
            </div>
            ${counts.review ? '<div class="ci-info">Rækker markeret med <strong>?</strong> har medium-confidence match. Vælg manuelt om der skal genbruges eksisterende firma eller oprettes nyt.</div>' : ''}
            <div class="ci-bulk">
                <button class="ci-bulk-btn" data-bulk="all_existing">Brug alle med høj confidence</button>
                <button class="ci-bulk-btn" data-bulk="all_review_as_new">Opret alle review som nye</button>
                <button class="ci-bulk-btn" data-bulk="all_review_as_existing">Brug eksisterende på alle review</button>
            </div>
            <div style="max-height:50vh;overflow:auto;">
                <table class="ci-preview-table">
                    <thead>
                        <tr>
                            <th style="width:48px;">#</th>
                            <th>Input</th>
                            <th>Match</th>
                            <th style="width:160px;">Handling</th>
                        </tr>
                    </thead>
                    <tbody>${tableRows}</tbody>
                </table>
            </div>
        `;
        footer.innerHTML = `
            <div style="font-size:13px;color:var(--color-text-dim);">
                ${totalAdds} medlemmer bliver tilføjet til kampagnen.
            </div>
            <div class="ci-footer-actions">
                <button class="ci-btn ci-btn-secondary" id="ci-back">← Tilbage</button>
                <button class="ci-btn ci-btn-primary" id="ci-commit" ${totalAdds === 0 ? 'disabled' : ''}>
                    Tilføj ${totalAdds} medlemmer
                </button>
            </div>
        `;

        // Wire per-row select
        body.querySelectorAll('.ci-action-select').forEach(sel => {
            sel.addEventListener('change', () => {
                const idx = parseInt(sel.dataset.rowIndex);
                const d = _state.decisions.find(x => x.row_index === idx);
                if (d) {
                    d.action = sel.value;
                    _renderStep();
                }
            });
        });

        // Wire bulk-actions
        body.querySelectorAll('.ci-bulk-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const op = btn.dataset.bulk;
                if (op === 'all_existing') {
                    _state.decisions.forEach(d => {
                        if (d._match_confidence && d._match_confidence >= 0.95 && !d._already_member) {
                            d.action = 'use_existing';
                        }
                    });
                } else if (op === 'all_review_as_new') {
                    _state.decisions.forEach(d => {
                        if (d.action === 'review') {
                            // Kun hvis vi har et navn at oprette med
                            if (d.input?.name) d.action = 'create_new';
                        }
                    });
                } else if (op === 'all_review_as_existing') {
                    _state.decisions.forEach(d => {
                        if (d.action === 'review' && d.company_id) d.action = 'use_existing';
                    });
                }
                _renderStep();
            });
        });

        document.getElementById('ci-back').addEventListener('click', () => {
            _state.step = 'mapping';
            _renderStep();
        });
        document.getElementById('ci-commit').addEventListener('click', _doCommit);
    }

    function _renderMatchCell(d) {
        const conf = d._match_confidence || 0;
        const confPct = Math.round(conf * 100);
        const memberNote = d._already_member ? ' <em style="color:#a13d2e;">(allerede medlem)</em>' : '';
        return `
            <span class="ci-conf-bar"><span class="ci-conf-fill" style="width:${confPct}%;"></span></span>
            ${confPct}% · ${_esc(d._match_name || '')}${memberNote}
        `;
    }

    async function _doCommit() {
        // Filtrér decisions så vi ikke sender server-felter med
        const payload = _state.decisions.map(d => ({
            row_index: d.row_index,
            action: d.action,
            company_id: d.company_id || undefined,
            input: d.input || undefined,
        }));
        _state.busy = true;
        document.getElementById('ci-commit').disabled = true;
        document.getElementById('ci-commit').textContent = 'Importerer…';
        try {
            const r = await commitCampaignImport(_state.campaignId, payload);
            _state.commitResult = r;
            _state.step = 'done';
            _state.busy = false;
            _renderStep();
            if (typeof _state.onDone === 'function') {
                // Lad caller vide at det er færdigt — fx for at re-loade pipeline
                _state.onDone(r);
            }
        } catch (err) {
            _state.busy = false;
            alert('Import fejlede: ' + (err.message || 'ukendt fejl'));
        }
    }

    // ─── Step 4: Færdig ─────────────────────────────────────────

    function _renderDone(body, footer, tabs) {
        const r = _state.commitResult || {};
        body.innerHTML = `
            ${tabs}
            <div style="text-align:center;padding:40px 20px;">
                <div style="font-size:48px;margin-bottom:14px;">✓</div>
                <h3 style="font-family:var(--font-heading,'Playfair Display',Georgia,serif);font-size:22px;margin:0 0 16px 0;">
                    Import gennemført
                </h3>
                <div class="ci-summary" style="justify-content:center;">
                    <div class="ci-summary-card">✓ <span class="ci-summary-num">${r.added || 0}</span> medlemmer tilføjet</div>
                    <div class="ci-summary-card">＋ <span class="ci-summary-num">${r.new_companies_created || 0}</span> nye firmaer oprettet</div>
                    <div class="ci-summary-card">⊘ <span class="ci-summary-num">${(r.skipped || []).length}</span> sprunget over</div>
                </div>
            </div>
        `;
        footer.innerHTML = `
            <div></div>
            <div class="ci-footer-actions">
                <button class="ci-btn ci-btn-primary" id="ci-done">Færdig</button>
            </div>
        `;
        document.getElementById('ci-done').addEventListener('click', _close);
    }

    window.CampaignImportDrawer = { open: _open };
})();
