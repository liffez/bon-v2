/**
 * office/views/crm-verktoj.js
 * ════════════════════════════════════════════════════════════
 * CRM → Værktøjer — Sammenlæg firmaer (merge-wizard).
 * Flyttet fra settings/index.html (CLAUDE_SETTINGS_REORG.md DEL 4A).
 *
 * Admin-only: merge-API'et (/api/admin/merge-companies*) er gated med
 * requireAuth('admin') server-side. Indholdet gates også klient-side, så
 * ikke-admins ser en notice i stedet for wizard'en.
 *
 * Endpoints (uændret):
 *   GET  /api/admin/merge-companies/preview?winner_id=&loser_id=
 *   POST /api/admin/merge-companies
 *   GET  /api/companies?q=                    (firma-søgning)
 *   GET  /api/companies/:id/enrich-preview    (CVR-verifikation)
 * ════════════════════════════════════════════════════════════
 */

/* ── CSS-injection (én gang) ───────────────────────────────── */
function _cvInjectStyles() {
    if (document.getElementById('cv-merge-styles')) return;
    const st = document.createElement('style');
    st.id = 'cv-merge-styles';
    st.textContent = `
    .cv-wrap .st-btn { padding:6px 16px; border:none; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer; font-family:var(--font-body); transition:background .15s, opacity .15s; background:var(--color-background); color:var(--color-text); border:1px solid var(--color-border); }
    .cv-wrap .st-btn:hover { background:var(--color-border); }
    .cv-wrap .st-btn-primary { background:var(--brand-primary); color:#fff; border-color:var(--brand-primary); }
    .cv-wrap .st-btn-primary:hover { opacity:.9; background:var(--brand-primary); }
    .cv-wrap .st-btn-sm { padding:4px 10px; font-size:12px; }
    .cv-wrap .st-btn:disabled { opacity:.5; cursor:not-allowed; }
    .merge-results { max-height:220px; overflow-y:auto; border:1px solid var(--color-border); border-top:none; border-radius:0 0 6px 6px; background:#fff; display:none; }
    .merge-results.visible { display:block; }
    .merge-result-row { padding:8px 12px; cursor:pointer; border-bottom:1px solid var(--color-border); font-size:13px; }
    .merge-result-row:last-child { border-bottom:none; }
    .merge-result-row:hover { background:#fbfaf6; }
    .merge-result-meta { font-size:11px; color:var(--color-text-dim); margin-top:2px; }
    .merge-pick { padding:10px 12px; background:#e3f0e6; border:1px solid #cfe2d4; border-radius:6px; margin-top:4px; display:flex; justify-content:space-between; align-items:center; }
    .merge-pick-info { font-size:13px; color:#2f6e3f; }
    .merge-pick-info strong { font-weight:600; color:#1f4d28; }
    .merge-pick-clear { background:none; border:1px solid transparent; color:#2f6e3f; cursor:pointer; font-size:16px; padding:2px 8px; border-radius:4px; }
    .merge-pick-clear:hover { background:#cfe2d4; }
    .merge-warnings { background:#faf1e6; border:1px solid #f1d98e; border-radius:6px; padding:12px 14px; margin:14px 0; }
    .merge-warnings h4 { font-size:13px; color:#c9742e; margin:0 0 6px; }
    .merge-warnings ul { margin:0; padding-left:18px; font-size:12px; color:#6a5410; }
    .merge-summary { background:var(--color-background); border:1px solid var(--color-border); border-radius:6px; padding:12px 14px; margin-bottom:14px; font-size:13px; }
    .merge-summary strong { color:var(--color-text); font-weight:600; }
    .merge-conflict-row { display:grid; grid-template-columns:140px 1fr; gap:12px; padding:10px 0; border-bottom:1px solid var(--color-border); }
    .merge-conflict-row:last-child { border-bottom:none; }
    .merge-conflict-label { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--color-text-dim); padding-top:4px; font-weight:600; }
    .merge-conflict-options { display:flex; flex-direction:column; gap:6px; }
    .merge-conflict-options label { font-size:13px; cursor:pointer; padding:6px 10px; border-radius:4px; display:flex; gap:8px; align-items:flex-start; }
    .merge-conflict-options label:hover { background:#fbfaf6; }
    .merge-conflict-options input[type="radio"] { margin-top:2px; }
    .merge-conflict-value { flex:1; word-break:break-word; }
    .merge-conflict-source { font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:var(--color-text-dim); margin-bottom:2px; }
    .merge-confirm-input { width:100%; padding:8px 12px; border:1px solid var(--color-border); border-radius:6px; font-size:13px; font-family:inherit; margin-top:6px; }
    .merge-verify-card { border:1px solid var(--color-border); border-radius:6px; padding:10px 14px; margin-bottom:8px; }
    .merge-verify-h { font-size:13px; color:var(--color-text); display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .merge-verify-konf { font-size:10px; font-weight:700; padding:1px 6px; border-radius:8px; text-transform:uppercase; letter-spacing:.04em; }
    .merge-verify-konf-ok   { background:#cfe2d4; color:#1f4d28; }
    .merge-verify-konf-warn { background:#f3eee0; color:#806c2f; }
    .merge-verify-konf-low  { background:#f3e6e3; color:#8a4738; }
    .merge-verify-grid { margin-top:6px; display:flex; flex-direction:column; gap:3px; }
    .merge-verify-row { display:grid; grid-template-columns:110px 1fr auto; gap:10px; font-size:12px; align-items:baseline; }
    .merge-verify-lbl { text-transform:uppercase; font-size:10px; letter-spacing:.04em; color:var(--color-text-dim); font-weight:600; }
    .merge-verify-val { color:var(--color-text); word-break:break-word; }
    `;
    document.head.appendChild(st);
}

/* ── Panel-markup ──────────────────────────────────────────── */
const _CV_PANEL_HTML = `
  <div class="cv-wrap" style="max-width:760px">
    <h2 style="margin:0 0 4px">Sammenlæg firmaer</h2>
    <p style="font-size:13px;color:var(--color-text-dim);margin-bottom:14px;max-width:680px;line-height:1.5;">
      Brug når to firmaer i basen i virkeligheden er det samme firma — fx stavefejl, forkortelser eller dobbeltoprettelse. Alle kunder, bons, tilbud og kontaktpunkter flyttes til vinderen, og taberen deaktiveres (ikke slettet permanent).
      En komplet snapshot af alle berørte rækker gemmes i changelog, så <code style="background:var(--color-background);padding:2px 5px;border-radius:3px;font-family:monospace;font-size:12px">node --experimental-sqlite scripts/undo-merge.js &lt;changelog_id&gt;</code> kan rulle handlingen tilbage hvis nødvendigt.
    </p>

    <div id="merge-step1">
      <div style="display:flex;flex-direction:column;gap:14px;max-width:700px">
        <div class="merge-picker">
          <label style="font-size:13px;font-weight:600;display:block;margin-bottom:4px;color:var(--color-text)">Vinder (det firma der BEHOLDES)</label>
          <input type="search" id="merge-winner-q" placeholder="Søg firma, CVR eller juridisk navn…"
                 style="width:100%;padding:8px 12px;border:1px solid var(--color-border);border-radius:6px;font-size:13px"
                 autocomplete="off"/>
          <div id="merge-winner-results" class="merge-results"></div>
          <div id="merge-winner-pick" class="merge-pick" style="display:none"></div>
        </div>

        <div class="merge-picker">
          <label style="font-size:13px;font-weight:600;display:block;margin-bottom:4px;color:var(--color-text)">Taber (det firma der DEAKTIVERES)</label>
          <input type="search" id="merge-loser-q" placeholder="Søg firma, CVR eller juridisk navn…"
                 style="width:100%;padding:8px 12px;border:1px solid var(--color-border);border-radius:6px;font-size:13px"
                 autocomplete="off"/>
          <div id="merge-loser-results" class="merge-results"></div>
          <div id="merge-loser-pick" class="merge-pick" style="display:none"></div>
        </div>

        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="st-btn st-btn-primary" id="merge-step1-next" disabled onclick="mergeGotoStep2()">Næste →</button>
        </div>
      </div>
    </div>

    <div id="merge-step2" style="display:none">
      <div id="merge-step2-content"></div>
    </div>

    <div id="merge-step3" style="display:none">
      <div id="merge-step3-content"></div>
    </div>
  </div>
`;

/* ══════════════════════════════════════════════════════════════
   MERGE-WIZARD (Sammenlæg firmaer) — porteret fra settings
   ══════════════════════════════════════════════════════════════ */
let _mergeState = {
    winner: null,
    loser: null,
    preview: null,
    field_choices: {},
    user_notes: '',
};

function _mergeDebounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function _mergeSearch(role, q) {
    const resultsEl = document.getElementById(`merge-${role}-results`);
    if (!q || q.length < 2) {
        resultsEl.classList.remove('visible');
        resultsEl.innerHTML = '';
        return;
    }
    try {
        const rows = await apiFetch('/companies?q=' + encodeURIComponent(q));
        if (rows.length === 0) {
            resultsEl.innerHTML = '<div class="merge-result-row" style="color:var(--color-text-dim);font-style:italic">Ingen match.</div>';
        } else {
            resultsEl.innerHTML = rows.map(r => `
                <div class="merge-result-row" data-id="${r.id}" data-name="${escapeHtml(r.name)}">
                    <strong>${escapeHtml(r.name)}</strong>
                    <div class="merge-result-meta">
                        ${r.cvr ? 'CVR ' + r.cvr : '<em>uden CVR</em>'}
                        ${r.ean ? ' · EAN ' + r.ean : ''}
                    </div>
                </div>
            `).join('');
            resultsEl.querySelectorAll('.merge-result-row[data-id]').forEach(el => {
                el.addEventListener('click', () => {
                    const id = parseInt(el.dataset.id, 10);
                    const name = el.dataset.name;
                    _mergePickCompany(role, { id, name });
                });
            });
        }
        resultsEl.classList.add('visible');
    } catch (err) {
        resultsEl.innerHTML = '<div class="merge-result-row" style="color:#b34234">Fejl: ' + escapeHtml(err.message) + '</div>';
        resultsEl.classList.add('visible');
    }
}

function _mergePickCompany(role, company) {
    if (role === 'winner' && _mergeState.loser?.id === company.id) {
        alert('Du kan ikke vælge samme firma som både vinder og taber.');
        return;
    }
    if (role === 'loser' && _mergeState.winner?.id === company.id) {
        alert('Du kan ikke vælge samme firma som både vinder og taber.');
        return;
    }
    _mergeState[role] = company;
    document.getElementById(`merge-${role}-q`).value = '';
    document.getElementById(`merge-${role}-results`).classList.remove('visible');

    const pickEl = document.getElementById(`merge-${role}-pick`);
    pickEl.style.display = '';
    pickEl.innerHTML = `
        <span class="merge-pick-info">
            ${role === 'winner' ? '✓ Vinder' : '✓ Taber'}: <strong>${escapeHtml(company.name)}</strong> (id ${company.id})
        </span>
        <button class="merge-pick-clear" onclick="_mergeClear('${role}')" title="Fjern">✕</button>
    `;
    document.getElementById('merge-step1-next').disabled = !(_mergeState.winner && _mergeState.loser);
}

function _mergeClear(role) {
    _mergeState[role] = null;
    document.getElementById(`merge-${role}-pick`).style.display = 'none';
    document.getElementById('merge-step1-next').disabled = !(_mergeState.winner && _mergeState.loser);
}
window._mergeClear = _mergeClear;

async function mergeGotoStep2() {
    const { winner, loser } = _mergeState;
    if (!winner || !loser) return;
    const step2El = document.getElementById('merge-step2-content');
    document.getElementById('merge-step1').style.display = 'none';
    document.getElementById('merge-step2').style.display = '';
    step2El.innerHTML = '<p>Henter preview…</p>';

    try {
        const preview = await apiFetch(`/admin/merge-companies/preview?winner_id=${winner.id}&loser_id=${loser.id}`);
        _mergeState.preview = preview;
        _mergeState.field_choices = {};
        _mergeRenderStep2(preview);
    } catch (err) {
        step2El.innerHTML = '<p style="color:#b34234">Fejl: ' + escapeHtml(err.message) + '</p>'
            + '<button class="st-btn" onclick="mergeBackToStep1()">← Tilbage</button>';
    }
}
window.mergeGotoStep2 = mergeGotoStep2;

function _mergeRenderStep2(preview) {
    const step2El = document.getElementById('merge-step2-content');
    const m = preview.moves;
    const summaryHtml = `
        <div class="merge-summary">
            <strong>Sammenlægning #${preview.loser.id} → #${preview.winner.id}</strong><br>
            <strong>${escapeHtml(preview.loser.name)}</strong> sammenlægges med <strong>${escapeHtml(preview.winner.name)}</strong>.
            <div style="margin-top:8px;font-size:12px;color:var(--color-text-dim)">
                Følgende flyttes til vinderen:
                <strong>${m.customers}</strong> kunde${m.customers === 1 ? '' : 'r'} ·
                <strong>${m.bons}</strong> bon${m.bons === 1 ? '' : 's'} ·
                ${m.booking_tokens > 0 ? '<strong>' + m.booking_tokens + '</strong> booking-token(s) · ' : ''}
                ${m.rfm_scores > 0 ? '<strong>' + m.rfm_scores + '</strong> RFM-score · ' : ''}
                <strong>${m.contact_points_moved}</strong> kontaktpunkt(er) flyttes,
                <strong>${m.contact_points_duplicates}</strong> duplikat(er) slettes
            </div>
        </div>
    `;

    let warningsHtml = '';
    if (preview.warnings && preview.warnings.length > 0) {
        warningsHtml = `
            <div class="merge-warnings">
                <h4>⚠ Advarsler</h4>
                <ul>
                    ${preview.warnings.map(w => `<li>${escapeHtml(w.text)}</li>`).join('')}
                </ul>
            </div>
        `;
    }

    let conflictsHtml = '';
    if (preview.conflicts && preview.conflicts.length > 0) {
        conflictsHtml = `
            <h3 style="margin-top:18px;font-size:14px;font-weight:600">Felt-valg</h3>
            <p style="font-size:12px;color:var(--color-text-dim);margin-bottom:8px">
                Vælg hvilken værdi der gemmes på vinderen for hvert felt med forskel.
            </p>
            <div>
                ${preview.conflicts.map(c => _mergeRenderConflict(c)).join('')}
            </div>
        `;
    } else {
        conflictsHtml = '<p style="font-size:12px;color:var(--color-text-dim);font-style:italic;margin-top:14px">Ingen feltforskelle — vinderens værdier bevares som de er.</p>';
    }

    step2El.innerHTML = `
        ${summaryHtml}
        ${warningsHtml}
        <div style="margin:14px 0">
            <button class="st-btn" id="merge-verify-btn" onclick="mergeVerifyCvr()">🔍 Verificér begge firmaer mod CVR</button>
            <div id="merge-verify-result" style="margin-top:10px"></div>
        </div>
        ${conflictsHtml}
        <div style="margin-top:18px">
            <label style="font-size:12px;font-weight:600;color:var(--color-text);display:block;margin-bottom:4px">Valgfri note om denne sammenlægning</label>
            <input type="text" id="merge-user-notes" class="merge-confirm-input" placeholder="Fx: Stavefejl rettet" style="margin-top:0"/>
        </div>
        <div style="margin-top:18px;display:flex;gap:8px">
            <button class="st-btn" onclick="mergeBackToStep1()">← Tilbage</button>
            <button class="st-btn st-btn-primary" onclick="mergeGotoStep3()">Næste →</button>
        </div>
    `;

    // Wire radio-bindings
    step2El.querySelectorAll('input[type="radio"][data-conflict]').forEach(input => {
        input.addEventListener('change', () => {
            _mergeState.field_choices[input.dataset.conflict] = input.value;
        });
        // Set default fra recommendation
        if (input.checked) {
            _mergeState.field_choices[input.dataset.conflict] = input.value;
        }
    });
}

function _mergeRenderConflict(c) {
    const winnerVal = c.winner_value === null || c.winner_value === undefined || c.winner_value === ''
        ? '<em style="color:var(--color-text-dim);font-style:italic">— ikke sat —</em>'
        : escapeHtml(String(c.winner_value));
    const loserVal = c.loser_value === null || c.loser_value === undefined || c.loser_value === ''
        ? '<em style="color:var(--color-text-dim);font-style:italic">— ikke sat —</em>'
        : escapeHtml(String(c.loser_value));

    const recommendation = c.recommendation || 'winner';
    const supportsMerge = (c.field === 'notes');

    return `
        <div class="merge-conflict-row">
            <div class="merge-conflict-label">${escapeHtml(c.field)}</div>
            <div class="merge-conflict-options">
                <label>
                    <input type="radio" name="merge-c-${c.field}" data-conflict="${c.field}" value="winner" ${recommendation === 'winner' ? 'checked' : ''}/>
                    <span class="merge-conflict-value">
                        <div class="merge-conflict-source">Vinder</div>
                        ${winnerVal}
                    </span>
                </label>
                <label>
                    <input type="radio" name="merge-c-${c.field}" data-conflict="${c.field}" value="loser" ${recommendation === 'loser' ? 'checked' : ''}/>
                    <span class="merge-conflict-value">
                        <div class="merge-conflict-source">Taber</div>
                        ${loserVal}
                    </span>
                </label>
                ${supportsMerge ? `
                <label>
                    <input type="radio" name="merge-c-${c.field}" data-conflict="${c.field}" value="merge" ${recommendation === 'merge' ? 'checked' : ''}/>
                    <span class="merge-conflict-value">
                        <div class="merge-conflict-source">Begge (sammensat)</div>
                        Vinderens tekst + ny separator + taberens tekst
                    </span>
                </label>` : ''}
            </div>
        </div>
    `;
}

async function mergeVerifyCvr() {
    const btn = document.getElementById('merge-verify-btn');
    const out = document.getElementById('merge-verify-result');
    if (!_mergeState.preview) return;
    btn.disabled = true;
    btn.textContent = 'Slår op…';
    out.innerHTML = '';

    const winId = _mergeState.preview.winner.id;
    const losId = _mergeState.preview.loser.id;

    try {
        const [winRes, losRes] = await Promise.all([
            apiFetch('/companies/' + winId + '/enrich-preview').catch(e => ({ error: e.message })),
            apiFetch('/companies/' + losId + '/enrich-preview').catch(e => ({ error: e.message })),
        ]);

        out.innerHTML = `
            ${_mergeRenderVerifyCard('Vinder', _mergeState.preview.winner, winRes)}
            ${_mergeRenderVerifyCard('Taber',  _mergeState.preview.loser,  losRes)}
            ${_mergeRenderSameCvrHint(winRes, losRes)}
        `;
    } catch (err) {
        out.innerHTML = `<div style="color:#b34234;font-size:12px">Fejl: ${escapeHtml(err.message)}</div>`;
    } finally {
        btn.disabled = false;
        btn.textContent = '🔍 Verificér igen';
    }
}
window.mergeVerifyCvr = mergeVerifyCvr;

function _mergeRenderVerifyCard(roleLabel, dbCompany, result) {
    if (result?.error) {
        return `
            <div class="merge-verify-card" style="border-color:#f1d98e;background:#faf1e6">
                <div class="merge-verify-h">${roleLabel}: <strong>${escapeHtml(dbCompany.name)}</strong> ${dbCompany.cvr ? '· CVR ' + dbCompany.cvr : '· uden CVR'}</div>
                <div style="font-size:12px;color:#6a5410">Opslag fejlede: ${escapeHtml(result.error)}</div>
            </div>
        `;
    }

    if (!result?.found) {
        return `
            <div class="merge-verify-card" style="border-color:#f1d98e;background:#faf1e6">
                <div class="merge-verify-h">${roleLabel}: <strong>${escapeHtml(dbCompany.name)}</strong> ${dbCompany.cvr ? '· CVR ' + dbCompany.cvr : '· uden CVR'}</div>
                <div style="font-size:12px;color:#6a5410">⚠ Ingen match i CVR/Virk. ${escapeHtml(result?.besked || '')}</div>
            </div>
        `;
    }

    const data = result.diff?.fields || [];
    const cvrField  = data.find(f => f.key === 'cvr');
    const nameField = data.find(f => f.key === 'legal_name');
    const branchField = data.find(f => f.key === 'branch');

    const dbName = dbCompany.name?.toLowerCase().trim() || '';
    const virkName = (nameField?.proposed || '').toLowerCase().trim();
    const nameMatch = virkName && (dbName === virkName || dbName.includes(virkName) || virkName.includes(dbName));

    const dbCvr = (dbCompany.cvr || '').replace(/\D/g, '');
    const virkCvr = (cvrField?.proposed || '').toString().replace(/\D/g, '');
    const cvrMatch = dbCvr && virkCvr && dbCvr === virkCvr;

    const konfPct = Math.round((result.konfidens || 0) * 100);
    const konfClass = konfPct >= 90 ? 'ok' : (konfPct >= 75 ? 'warn' : 'low');

    return `
        <div class="merge-verify-card" style="border-color:#cfe2d4;background:#e3f0e6">
            <div class="merge-verify-h">
                ${roleLabel}: <strong>${escapeHtml(dbCompany.name)}</strong> ${dbCompany.cvr ? '· CVR ' + dbCompany.cvr : '· uden CVR'}
                <span class="merge-verify-konf merge-verify-konf-${konfClass}">${konfPct}%</span>
            </div>
            <div style="font-size:12px;color:#1f4d28;margin-top:4px">
                ✓ Match via ${escapeHtml(result.kilde)}
            </div>
            <div class="merge-verify-grid">
                ${_mergeVerifyRow('CVR (Virk)', virkCvr || '—', dbCvr ? (cvrMatch ? '✓' : '✗ DB ≠ Virk') : '⚠ DB mangler')}
                ${_mergeVerifyRow('Navn (Virk)', nameField?.proposed || '—', nameMatch ? '✓' : '⚠ DB-navn ≠ Virk-navn')}
                ${branchField?.proposed ? _mergeVerifyRow('Branche', branchField.proposed, '') : ''}
            </div>
        </div>
    `;
}

function _mergeVerifyRow(label, virkValue, status) {
    const statusColor = status.startsWith('✓') ? '#2f6e3f' : (status.startsWith('⚠') ? '#c9742e' : (status.startsWith('✗') ? '#b34234' : 'var(--color-text-dim)'));
    return `
        <div class="merge-verify-row">
            <span class="merge-verify-lbl">${escapeHtml(label)}</span>
            <span class="merge-verify-val">${escapeHtml(String(virkValue))}</span>
            ${status ? `<span style="color:${statusColor};font-size:11px;font-weight:600">${escapeHtml(status)}</span>` : '<span></span>'}
        </div>
    `;
}

function _mergeRenderSameCvrHint(winRes, losRes) {
    const winCvr = winRes?.diff?.fields?.find(f => f.key === 'cvr')?.proposed;
    const losCvr = losRes?.diff?.fields?.find(f => f.key === 'cvr')?.proposed;
    if (winCvr && losCvr && String(winCvr) === String(losCvr)) {
        return `
            <div style="margin-top:10px;padding:10px 14px;background:#e6eef3;border:1px solid #cfd9e3;border-radius:6px;font-size:12px;color:#3d6a87">
                ℹ <strong>Begge firmaer slår op til samme CVR i Virk (${escapeHtml(String(winCvr))})</strong> — det er en stærk indikation på at det reelt er samme firma. Sammenlægning anbefales.
            </div>
        `;
    }
    if (winRes?.found && losRes?.found && winCvr !== losCvr) {
        return `
            <div style="margin-top:10px;padding:10px 14px;background:#faf1e6;border:1px solid #f1d98e;border-radius:6px;font-size:12px;color:#6a5410">
                ⚠ <strong>De to firmaer slår op til forskellige CVR'er i Virk</strong> (${escapeHtml(String(winCvr || '—'))} vs ${escapeHtml(String(losCvr || '—'))}). Måske er de IKKE samme firma. Tjek nøje før du fortsætter.
            </div>
        `;
    }
    return '';
}

function mergeBackToStep1() {
    document.getElementById('merge-step2').style.display = 'none';
    document.getElementById('merge-step3').style.display = 'none';
    document.getElementById('merge-step1').style.display = '';
}
window.mergeBackToStep1 = mergeBackToStep1;

function mergeGotoStep3() {
    const userNotes = document.getElementById('merge-user-notes')?.value?.trim() || '';
    _mergeState.user_notes = userNotes;
    document.getElementById('merge-step2').style.display = 'none';
    document.getElementById('merge-step3').style.display = '';

    const w = _mergeState.preview.winner;
    const l = _mergeState.preview.loser;
    const hasWarnings = (_mergeState.preview.warnings || []).length > 0;

    document.getElementById('merge-step3-content').innerHTML = `
        <div class="merge-summary">
            <strong>Bekræft sammenlægning</strong><br>
            Du er ved at sammenlægge firma <strong>#${l.id} (${escapeHtml(l.name)})</strong> ind i firma <strong>#${w.id} (${escapeHtml(w.name)})</strong>.<br>
            <span style="color:#b34234">Dette kan kun rulles tilbage manuelt via <code>scripts/undo-merge.js</code>.</span><br>
            Handlingen logges i changelog (et changelog-id returneres efter merge).
        </div>

        <label style="font-size:12px;font-weight:600;color:var(--color-text);display:block;margin-bottom:4px">
            Skriv vinderens navn for at bekræfte:
        </label>
        <input type="text" id="merge-confirm-input" class="merge-confirm-input"
               placeholder="${escapeHtml(w.name)}"
               oninput="_mergeUpdateConfirmBtn()" autocomplete="off"/>
        <div style="font-size:11px;color:var(--color-text-dim);margin-top:4px">
            (Skriv "${escapeHtml(w.name)}" eksakt)
        </div>

        ${hasWarnings ? `
        <div style="margin-top:14px">
            <label style="font-size:13px;display:flex;gap:8px;align-items:center;cursor:pointer">
                <input type="checkbox" id="merge-force" onchange="_mergeUpdateConfirmBtn()"/>
                ⚠ Overstyr advarsler (force)
            </label>
        </div>
        ` : ''}

        <div style="margin-top:18px;display:flex;gap:8px;justify-content:space-between">
            <button class="st-btn" onclick="mergeGotoStep2()">← Tilbage</button>
            <div style="display:flex;gap:8px">
                <button class="st-btn" onclick="mergeCancel()">Annullér</button>
                <button class="st-btn st-btn-primary" id="merge-confirm-btn" disabled onclick="mergeExecute()">✓ Sammenlæg</button>
            </div>
        </div>
    `;
}
window.mergeGotoStep3 = mergeGotoStep3;

function _mergeUpdateConfirmBtn() {
    const input = document.getElementById('merge-confirm-input');
    const btn = document.getElementById('merge-confirm-btn');
    const w = _mergeState.preview.winner;
    const hasWarnings = (_mergeState.preview.warnings || []).length > 0;
    const forceCb = document.getElementById('merge-force');

    const nameMatches = input?.value?.trim() === w.name;
    const forceOk = !hasWarnings || (forceCb && forceCb.checked);
    btn.disabled = !(nameMatches && forceOk);
}
window._mergeUpdateConfirmBtn = _mergeUpdateConfirmBtn;

function mergeCancel() {
    if (!confirm('Vil du virkelig annullere denne sammenlægning?')) return;
    _mergeState = { winner: null, loser: null, preview: null, field_choices: {}, user_notes: '' };
    document.getElementById('merge-step2').style.display = 'none';
    document.getElementById('merge-step3').style.display = 'none';
    document.getElementById('merge-step1').style.display = '';
    ['winner','loser'].forEach(role => {
        document.getElementById(`merge-${role}-pick`).style.display = 'none';
        document.getElementById(`merge-${role}-q`).value = '';
    });
    document.getElementById('merge-step1-next').disabled = true;
}
window.mergeCancel = mergeCancel;

async function mergeExecute() {
    const btn = document.getElementById('merge-confirm-btn');
    btn.disabled = true;
    btn.textContent = 'Sammenlægger…';

    const hasWarnings = (_mergeState.preview.warnings || []).length > 0;
    const force = hasWarnings && document.getElementById('merge-force')?.checked;

    try {
        const result = await apiFetch('/admin/merge-companies', {
            method: 'POST',
            body: JSON.stringify({
                winner_id: _mergeState.winner.id,
                loser_id: _mergeState.loser.id,
                field_choices: _mergeState.field_choices,
                user_notes: _mergeState.user_notes,
                force,
            }),
        });

        document.getElementById('merge-step3-content').innerHTML = `
            <div class="merge-summary" style="background:#e3f0e6;border-color:#cfe2d4;color:#2f6e3f">
                <strong>✓ Sammenlægning gennemført</strong><br>
                Changelog-id: <strong>${result.changelog_id}</strong> · gemt: ${JSON.stringify(result.moves_executed)}<br>
                <div style="margin-top:8px;font-size:12px">
                    Rul tilbage med:<br>
                    <code style="background:white;padding:4px 8px;border-radius:3px;font-family:monospace;font-size:11px;display:inline-block;margin-top:4px">node --experimental-sqlite scripts/undo-merge.js ${result.changelog_id}</code>
                </div>
            </div>
            <button class="st-btn" onclick="mergeCancel()">Sammenlæg flere</button>
        `;
    } catch (err) {
        btn.disabled = false;
        btn.textContent = '✓ Sammenlæg';
        alert('Fejl: ' + err.message);
    }
}
window.mergeExecute = mergeExecute;

// escapeHtml er allerede global i office (crm-firmaer.js m.fl.), men defineres
// her også for at gøre viewet selvstændigt. Function-deklaration = sikker redeklaration.
function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[ch]));
}

function _cvWireSearch() {
    const winQ = document.getElementById('merge-winner-q');
    const losQ = document.getElementById('merge-loser-q');
    if (winQ) winQ.addEventListener('input', _mergeDebounce(e => _mergeSearch('winner', e.target.value), 280));
    if (losQ) losQ.addEventListener('input', _mergeDebounce(e => _mergeSearch('loser', e.target.value), 280));
}

/* ══════════════════════════════════════════════════════════════
   ENTRY
   ══════════════════════════════════════════════════════════════ */
async function initCrmVerktoj(container, opts = {}) {
    _cvInjectStyles();

    // Admin-gating: merge-API'et er admin-only server-side. Vis notice for ikke-admins.
    let role = null;
    try {
        const me = await apiFetch('/auth/me');
        role = me && me.role;
    } catch (e) { /* falder igennem til notice */ }

    if (role !== 'admin') {
        container.innerHTML = `
            <div class="cv-wrap" style="max-width:620px">
                <h2 style="margin:0 0 8px">Værktøjer</h2>
                <div style="padding:18px 20px;background:var(--color-background);border:1px solid var(--color-border);border-radius:8px;font-size:14px;color:var(--color-text-dim)">
                    🔒 <strong>Sammenlæg firmaer</strong> er kun tilgængeligt for administratorer.
                </div>
            </div>`;
        return;
    }

    _mergeState = { winner: null, loser: null, preview: null, field_choices: {}, user_notes: '' };
    container.innerHTML = _CV_PANEL_HTML;
    _cvWireSearch();
}
