/**
 * office/views/cashflow.js
 * ════════════════════════════════════════════════════════════
 * Cashflow-modul — Pengestrøm (admin-only).
 * Tab 1: Overblik (metrics, chart, fakturaer, upload)
 * Tab 2: Analyse (YTD, pax-segmenter, heatmap, betalingsadfærd)
 *
 * Entry: initCashflow(containerEl)
 * Cleanup: cleanupCashflow()
 * ════════════════════════════════════════════════════════════
 */

/* ── State ── */
let _cfEl = null;
let _cfTab = 'overblik';
let _cfInvTab = 'alle';
let _cfInvForm = null;       // null | 'create' | invoice-id
let _cfResizeHandler = null;
let _cfOpts = {};            // { openDrawer? } injected from office-shell
let _cfUnmatched = {};       // tx-id → tx (umatchede posteringer i overblikket)
let _cfUmInvCache = null;    // (legacy — ikke længere brugt af panelet)
let _cfAllocDraft = {};      // tx-id → { lines:[{target_type,target_id,label,sublabel,amount}], existing:[] }
let _cfAllocSearchTimer = null;
let _cfBonDraft = {};        // tx-id → { lines:[...] } til "opret bon fra indbetaling"
let _cfRecipeCache = null;   // Grocy sellable recipes (id,name,category,prices,cost_price,co2e)
let _cfRecipeByName = null;  // Map: lowercased navn → recipe
const _CF_PAY_OPTS = [['card','Kort/Zettle'],['mobilepay','MobilePay'],['cash','Kontant'],['pos','POS']];

/** Hent + cache Grocy-opskrifter (til menu-autocomplete i Opret bon). Tom ved fejl. */
async function _cfLoadRecipes() {
    if (_cfRecipeCache) return _cfRecipeCache;
    try {
        const raw = await fetchGrocyRecipes();
        _cfRecipeCache = (Array.isArray(raw) ? raw : (raw.recipes || []))
            .map(r => ({ ...r, name: (r.name || '').trim() }))
            .filter(r => r.name);
    } catch { _cfRecipeCache = []; }
    _cfRecipeByName = new Map(_cfRecipeCache.map(r => [r.name.toLowerCase(), r]));
    return _cfRecipeCache;
}
function _cfRecipeFestival(r) { return (r && r.prices && Number(r.prices.festival)) || null; }

// Justeringer dækker differencen mellem allokeret og indbetaling — begge veje:
// negativ (gebyr/afgift trækkes fra) ELLER positiv (fx levering der ikke kom med
// på bonen, drikkepenge, afrunding).
const _CF_FEE_KINDS = [
    { id: 'gebyr', label: 'Gebyr (−)' },
    { id: 'afgift', label: 'Afgift (−)' },
    { id: 'zettle', label: 'Zettle-gebyr (−)' },
    { id: 'levering', label: 'Levering (+)' },
    { id: 'drikkepenge', label: 'Drikkepenge (+)' },
    { id: 'diff', label: 'Difference / afrunding (±)' },
];
const _CF_TARGET_BADGE = {
    bon:     { txt: 'Bon',     bg: '#4a6e96' },
    invoice: { txt: 'Faktura', bg: '#8e631f' },
    event:   { txt: 'Event',   bg: '#7a9c54' },
    fee:     { txt: 'Just.',   bg: '#7a8a96' },
};
function _cfBadgeHtml(type, expense) {
    const b = expense ? { txt: 'Udgift', bg: '#bc3a3a' } : (_CF_TARGET_BADGE[type] || { txt: type, bg: '#999' });
    return `<span class="cf-alloc-badge" style="background:${b.bg}">${b.txt}</span>`;
}

// Analyse state
let _cfPaxPeriod = 'maaned';
let _cfPaxView = 'oversigt';
let _cfPaxUnit = 'kr';
let _cfRefOn = false;
let _cfCurIdx = 0;
let _cfYtdRefs = { cur: true, prev: true, prevprev: true };
let _cfAnalyseData = null;

const _CF_MONTHS = ['Jan','Feb','Mar','Apr','Maj','Jun','Jul','Aug','Sep','Okt','Nov','Dec'];
const _CF_SEGS = ['sm','md','lg','xl','festival'];
const _CF_SEG_COLORS = { sm:'#d7d1ca', md:'#e8a832', lg:'#7a9c54', xl:'#4a6e96', festival:'#8e631f' };
const _CF_SEG_NAMES = { sm:'0–20 pax', md:'20–70 pax', lg:'70–150 pax', xl:'150+ pax', festival:'Festival' };
const _CF_PAX_WIN = { uge:5, maaned:5, kvartal:4 };

/* ── Helpers ── */
function _cfFmt(n) {
    if (n == null) return '—';
    return Math.round(n).toLocaleString('da-DK') + ' kr';
}

function _cfFmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const day = d.getDate();
    const mon = _CF_MONTHS[d.getMonth()].toLowerCase();
    // Vis året når datoen ikke er i indeværende år — så gamle fakturaer er
    // tydelige uden at rode nutidige datoer til.
    const y = d.getFullYear();
    return y === new Date().getFullYear() ? `${day}. ${mon}` : `${day}. ${mon} ${y}`;
}

function _cfDaysSince(iso) {
    if (!iso) return 999;
    return Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
}

function _cfDaysUntil(iso) {
    if (!iso) return 0;
    return Math.round((new Date(iso).getTime() - Date.now()) / 86400000);
}

/* ══════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════ */

async function initCashflow(container, opts) {
    _cfEl = container;
    _cfOpts = opts || {};
    _cfTab = 'overblik';
    _cfInvTab = 'alle';
    _cfInvForm = null;

    _cfEl.innerHTML = `
        <div class="cf-wrap">
            <div class="cf-tabs">
                <button class="cf-tab active" data-tab="overblik">Overblik</button>
                <button class="cf-tab" data-tab="analyse">Analyse</button>
            </div>
            <div id="cfContent"></div>
        </div>
        <div class="cf-tooltip" id="cfTooltip"></div>
    `;

    _cfEl.querySelectorAll('.cf-tab').forEach(btn => {
        btn.onclick = () => {
            _cfEl.querySelectorAll('.cf-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _cfTab = btn.dataset.tab;
            if (_cfTab === 'overblik') _cfRenderOverblik();
            else _cfRenderAnalyse();
        };
    });

    _cfRenderOverblik();
}

function cleanupCashflow() {
    if (_cfResizeHandler) {
        window.removeEventListener('resize', _cfResizeHandler);
        _cfResizeHandler = null;
    }
    _cfEl = null;
    _cfAnalyseData = null;
}

/* ══════════════════════════════════════════════════════════
   TAB 1: OVERBLIK
   ══════════════════════════════════════════════════════════ */

async function _cfRenderOverblik() {
    const content = _cfEl.querySelector('#cfContent');
    content.innerHTML = '<div class="cf-empty"><div class="cf-empty-icon">⏳</div>Henter data...</div>';

    try {
        const [stats, weekly, invoices, upcoming, unmatched, eventIncome] = await Promise.all([
            fetchCfStats(),
            fetchCfWeekly(),
            fetchCfInvoices(_cfInvTab),
            fetchCfUpcoming(),
            fetchCfTransactions({ unmatched: true, limit: 25 }),
            fetchCfEventIncome().catch(() => ({ events: [] }))
        ]);

        _cfBuildOverblik(content, stats, weekly, invoices, upcoming, unmatched, eventIncome);
    } catch (err) {
        content.innerHTML = `<div class="cf-empty"><div class="cf-empty-icon">⚠️</div>${err.message}</div>`;
    }
}

function _cfBuildOverblik(el, stats, weekly, invoices, upcoming, unmatched, eventIncome) {
    _cfUnmatched = {};
    (unmatched.rows || []).forEach(tx => { _cfUnmatched[tx.id] = tx; });
    const daysSince = _cfDaysSince(stats.last_upload);
    const staleClass = daysSince <= 1 ? 'ok' : '';
    const staleText = daysSince <= 1 ? 'Bankdata opdateret i dag'
        : daysSince >= 999 ? 'Ingen bankdata uploadet' : `Bankdata ${daysSince} dage gammel`;

    el.innerHTML = `
        <!-- Header bar -->
        <div class="cf-header-bar">
            <div class="cf-stale-badge ${staleClass}">
                <div class="cf-stale-dot"></div>
                <span>${staleText}</span>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
                <span class="cf-econ-badge" id="cfEconBadge" title="Seneste dato e-conomic har bogført til"></span>
                <button class="cf-upload-btn" id="cfReconcileBtn" title="Hent betalt-status fra e-conomic">⟳ Synk e-conomic</button>
                <button class="cf-upload-btn" id="cfUploadBtn">↑ Upload CSV</button>
                <input type="file" id="cfCsvInput" accept=".csv" style="display:none">
            </div>
        </div>

        <!-- Metrics — cashflow konvention: incl moms primær (faktiske bankbevægelser).
             Se BON_V2_PRINCIPPER.md sektion 6c. -->
        <div class="cf-metrics">
            <div class="cf-metric positive">
                <div class="cf-metric-label">Bankindestående (incl moms)</div>
                <div class="cf-metric-value ${stats.saldo != null ? 'green' : ''}">${stats.saldo != null ? _cfFmt(stats.saldo) : '—'}</div>
                <div class="cf-metric-sub">Baseret på uploaded CSV</div>
            </div>
            <div class="cf-metric warning">
                <div class="cf-metric-label">Udestående fakturaer (incl moms)</div>
                <div class="cf-metric-value">${_cfFmt(stats.outstanding_total)}</div>
                <div class="cf-metric-sub">${stats.outstanding_count} fakturaer · heraf moms-forpligtelse: ${_cfFmt(stats.outstanding_vat_liability || 0)}</div>
            </div>
            <div class="cf-metric alert">
                <div class="cf-metric-label">Forfaldne (incl moms, ikke betalt)</div>
                <div class="cf-metric-value ${stats.overdue_count > 0 ? 'red' : ''}">${_cfFmt(stats.overdue_total)}</div>
                <div class="cf-metric-sub">${stats.overdue_count} fakturaer overdue</div>
            </div>
            <div class="cf-metric neutral">
                <div class="cf-metric-label">Forventet ind — 30 dage (incl moms)</div>
                <div class="cf-metric-value">${_cfFmt(stats.expected_30d_total)}</div>
                <div class="cf-metric-sub">Heraf moms til SKAT: ${_cfFmt(stats.expected_30d_vat_liability || 0)} · Disponibelt for drift: ${_cfFmt(stats.expected_30d_total_excl_moms || 0)}</div>
            </div>
        </div>

        <!-- Main grid -->
        <div class="cf-main-grid">
            <div>
                <!-- Weekly chart -->
                <div class="cf-card">
                    <div class="cf-card-title">
                        Bankbevægelser — næste 8 uger (incl moms)
                        <span style="font-weight:400;font-size:11px">Estimat baseret på forfaldsdatoer · alle tal incl moms</span>
                    </div>
                    <div class="cf-chart-bars" id="cfChartBars"></div>
                    <div class="cf-chart-legend">
                        <div class="cf-legend-item"><div class="cf-legend-dot" style="background:#7a9c54"></div>Modtaget</div>
                        <div class="cf-legend-item"><div class="cf-legend-dot" style="background:#7594b3;opacity:.7"></div>Forventet</div>
                        <div class="cf-legend-item"><div class="cf-legend-dot" style="background:#bc3a3a;opacity:.85"></div>Forfalden</div>
                    </div>
                </div>

                <!-- Invoice list -->
                <div class="cf-invoice-list">
                    <div class="cf-inv-filters" id="cfInvFilters">
                        ${_cfRenderTabBtn('alle', 'Alle', invoices.summary)}
                        ${_cfRenderTabBtn('udestaaende', 'Udestående', invoices.summary)}
                        ${_cfRenderTabBtn('forfaldne', 'Forfaldne', invoices.summary)}
                        ${_cfRenderTabBtn('sandsynlig', 'Sandsynlig betalt', invoices.summary)}
                        ${_cfRenderTabBtn('betalt', 'Betalt', invoices.summary)}
                    </div>
                    <div style="padding:8px 16px;display:flex;justify-content:flex-end;gap:8px">
                        <button class="cf-btn cf-btn-ghost" id="cfBulkBtn" style="font-size:12px;padding:5px 12px;display:none">Marker mange som betalt…</button>
                        <button class="cf-btn cf-btn-primary" id="cfAddInvBtn" style="font-size:12px;padding:5px 12px">+ Ny faktura</button>
                    </div>
                    <div id="cfInvFormArea"></div>
                    <div class="cf-inv-row header-row">
                        <div>Faktura</div>
                        <div>Kunde</div>
                        <div style="text-align:right">Beløb</div>
                        <div style="text-align:right">Forfald</div>
                        <div style="text-align:center">Status</div>
                    </div>
                    <div id="cfInvRows"></div>
                    <div class="cf-inv-footer" id="cfInvFooter"></div>
                </div>
            </div>

            <!-- Right column -->
            <div class="cf-right-col">
                <div class="cf-upload-card" id="cfUploadCard">
                    <div class="cf-upload-icon">🏦</div>
                    <div class="cf-upload-card-title">Upload bankudtog</div>
                    <div class="cf-upload-card-sub">Nykredit / Fælles Kassen CSV-format<br>Matches automatisk mod fakturaer</div>
                    <button class="cf-upload-card-btn">Vælg fil</button>
                    <div class="cf-last-upload">${stats.last_upload ? 'Sidst uploadet: ' + new Date(stats.last_upload).toLocaleString('da-DK') : 'Ingen upload endnu'}</div>
                </div>

                ${unmatched.rows.length > 0 ? `
                <div class="cf-unmatched-card">
                    <div class="cf-unmatched-header">⚠️ ${unmatched.total > unmatched.rows.length ? unmatched.rows.length + ' af ' + unmatched.total : unmatched.rows.length} posteringer kan ikke matches</div>
                    <div id="cfUnmatchedList">
                    ${unmatched.rows.map(tx => `
                        <div class="cf-unmatched-item" data-tx-id="${tx.id}">
                            <div class="cf-unmatched-row" data-tx-row="${tx.id}">
                                <div>
                                    <div style="font-weight:700">${_cfEsc(tx.tekst).substring(0, 40)}</div>
                                    <span style="font-size:11px;color:#8a8580">${_cfFmtDate(tx.dato)}${tx.note ? ' · 📝' : ''}</span>
                                </div>
                                <div style="font-weight:700;color:${tx.beloeb < 0 ? '#bc3a3a' : '#e8a832'}">${_cfFmt(tx.beloeb)}</div>
                            </div>
                            <div class="cf-um-panel" data-tx-panel="${tx.id}" hidden></div>
                        </div>
                    `).join('')}
                    </div>
                </div>` : ''}

                ${_cfEventIncomeCard(eventIncome)}

                ${upcoming.rows.length > 0 ? `
                <div class="cf-upcoming-card">
                    <div class="cf-upcoming-header">Forfalder snart</div>
                    ${upcoming.rows.map(inv => {
                        const days = _cfDaysUntil(inv.forfald);
                        const cls = days < 0 ? 'overdue' : days <= 3 ? 'soon' : 'normal';
                        const daysLabel = days < 0 ? `${Math.abs(days)} dage over` : `${days} dage`;
                        return `
                        <div class="cf-upcoming-item">
                            <div>
                                <div class="cf-upcoming-name">${inv.kunde}</div>
                                <div class="cf-upcoming-date">${days < 0 ? 'Forfaldt' : 'Forfald'} ${_cfFmtDate(inv.forfald)}</div>
                            </div>
                            <div class="cf-upcoming-amount ${cls}">
                                ${_cfFmt(inv.beloeb)}
                                <span class="cf-days-badge ${cls}">${daysLabel}</span>
                            </div>
                        </div>`;
                    }).join('')}
                </div>` : ''}
            </div>
        </div>
    `;

    // Weekly chart
    _cfBuildWeeklyChart(weekly.weeks);

    // Invoice rows + footer + tab-counts
    _cfBuildInvoiceRows(invoices.rows, _cfInvTab);
    _cfBuildInvoiceFooter(invoices.summary, _cfInvTab);

    // Event: upload
    const csvInput = el.querySelector('#cfCsvInput');
    const uploadBtn = el.querySelector('#cfUploadBtn');
    const uploadCard = el.querySelector('#cfUploadCard');

    uploadBtn.onclick = () => csvInput.click();
    uploadCard.onclick = () => csvInput.click();
    csvInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            uploadBtn.textContent = 'Uploader...';
            uploadBtn.disabled = true;
            const result = await uploadCashflowCSV(file);
            alert(`Upload færdig!\n\n${result.total_rows} rækker læst\n${result.inserted} nye transaktioner\n${result.duplicates} dubletter sprunget over\n${result.matched} matches fundet`);
            _cfRenderOverblik();
        } catch (err) {
            alert('Upload fejlede: ' + err.message);
        } finally {
            uploadBtn.textContent = '↑ Upload CSV';
            uploadBtn.disabled = false;
            csvInput.value = '';
        }
    };

    // e-conomic-afstemning: badge (vandmærke) + "Synk e-conomic"-knap
    const econBadge = el.querySelector('#cfEconBadge');
    const reconBtn = el.querySelector('#cfReconcileBtn');
    fetchReconcileStatus().then(s => {
        if (!econBadge) return;
        if (!s.configured) { econBadge.textContent = 'e-conomic ikke konfigureret'; reconBtn.disabled = true; }
        else econBadge.textContent = s.economic_booked_until ? `Fakturastatus ajour til ${s.economic_booked_until}` : 'Ikke afstemt endnu';
    }).catch(() => {});
    if (reconBtn) reconBtn.onclick = async () => {
        try {
            reconBtn.textContent = 'Synker...'; reconBtn.disabled = true;
            const r = await reconcileCashflow({});
            alert(`Afstemning færdig!\n\n${r.scanned} fakturaer scannet\n${r.matched} koblet til bons\n${r.flipped} markeret betalt`);
            _cfRenderOverblik();
        } catch (err) {
            alert('Afstemning fejlede: ' + err.message);
            reconBtn.textContent = '⟳ Synk e-conomic'; reconBtn.disabled = false;
        }
    };

    // Invoice tab switching — _cfRefreshTabs wirer click-handlers
    _cfRefreshTabs(invoices.summary);

    // Add invoice button
    el.querySelector('#cfAddInvBtn').onclick = () => _cfShowInvForm(el);

    // Bulk-confirm button (vis kun på Forfaldne-fanen)
    const bulkBtn = el.querySelector('#cfBulkBtn');
    if (bulkBtn) {
        bulkBtn.style.display = _cfInvTab === 'forfaldne' ? '' : 'none';
        bulkBtn.onclick = () => _cfShowBulkModal();
    }

    // Umatchede posteringer — klik på række åbner handlings-panel
    _cfWireUnmatched(el);
}

/* ── Umatchede posteringer: match / ignorér / note ── */

function _cfWireUnmatched(el) {
    const list = el.querySelector('#cfUnmatchedList');
    if (!list) return;
    list.querySelectorAll('.cf-unmatched-row').forEach(row => {
        row.onclick = () => {
            const id = row.getAttribute('data-tx-row');
            const panel = list.querySelector(`.cf-um-panel[data-tx-panel="${id}"]`);
            if (!panel) return;
            if (!panel.hidden) { panel.hidden = true; return; }
            // Luk øvrige paneler
            list.querySelectorAll('.cf-um-panel').forEach(p => { p.hidden = true; });
            _cfBuildUmPanel(panel, id);
            panel.hidden = false;
        };
    });
}

/** §2.E per-event-indtægtsoverblik — kompakt kort (kun events med koblinger). */
function _cfEventIncomeCard(eventIncome) {
    const events = (eventIncome && eventIncome.events) || [];
    if (!events.length) return '';
    const totalNet = events.reduce((s, e) => s + (e.net || 0), 0);
    return `
        <div class="cf-event-income-card">
            <div class="cf-event-income-header">
                <span>🎪 Event-indtægt (bank-afstemt)</span>
                <span class="cf-event-income-total">${_cfFmt(totalNet)}</span>
            </div>
            ${events.map(e => `
                <div class="cf-event-income-row">
                    <div class="cf-event-income-name">
                        <div>${_cfEsc(e.name)}</div>
                        <div class="cf-event-income-sub">${[e.start_date, e.end_date].filter(Boolean).join(' → ')} · ${e.tx_count} ${e.tx_count === 1 ? 'indbetaling' : 'indbetalinger'}</div>
                    </div>
                    <div class="cf-event-income-amts">
                        <span class="cf-event-income-net">${_cfFmt(e.net)}</span>
                        ${Math.abs(e.fees) >= 0.01 ? `<span class="cf-event-income-fee">brutto ${_cfFmt(e.gross)} · fradrag ${_cfFmt(e.fees)}</span>` : ''}
                    </div>
                </div>
            `).join('')}
        </div>`;
}

async function _cfBuildUmPanel(panel, id) {
    const tx = _cfUnmatched[id] || {};
    _cfAllocDraft[id] = { lines: [], existing: [] };
    panel.innerHTML = `
        <div class="cf-um-actions">
            <button class="cf-um-btn cf-um-alloc-toggle">🔗 Kobl / split</button>
            <button class="cf-um-btn cf-um-bon-toggle">🧾 Opret bon</button>
            <button class="cf-um-btn cf-um-ignore">🚫 Ignorér</button>
        </div>
        <div class="cf-um-bon" hidden></div>
        <div class="cf-um-alloc" hidden>
            <div class="cf-alloc-head">
                <span>Fordel <strong>${_cfFmt(tx.beloeb)}</strong></span>
                <span class="cf-alloc-rest" data-rest></span>
            </div>
            <div class="cf-alloc-lines" data-lines></div>
            <div class="cf-alloc-search-wrap">
                <input class="cf-um-search" type="text" placeholder="Søg bon, faktura eller event…" autocomplete="off">
                <button class="cf-um-btn cf-alloc-fee" title="Tilføj justering (+/−): gebyr/afgift eller levering/diff">+ Justering</button>
            </div>
            <div class="cf-um-target-list"></div>
            <div class="cf-alloc-foot">
                <button class="cf-um-btn cf-um-btn-primary cf-alloc-save" disabled>Gem allokering</button>
            </div>
        </div>
        <div class="cf-um-note">
            <textarea class="cf-um-note-input" rows="2" placeholder="Note (fx 'tilbageført – forkert konto')">${_cfEsc(tx.note || '')}</textarea>
            <button class="cf-um-btn cf-um-note-save">Gem note</button>
        </div>
    `;

    // Ignorér
    panel.querySelector('.cf-um-ignore').onclick = async (e) => {
        e.stopPropagation();
        try {
            await patchCfTransaction(id, { ignored: 1 });
            _cfRenderOverblik();
        } catch (err) { alert('Kunne ikke ignorere: ' + err.message); }
    };

    // Note
    panel.querySelector('.cf-um-note-save').onclick = async (e) => {
        e.stopPropagation();
        const val = panel.querySelector('.cf-um-note-input').value;
        try {
            await patchCfTransaction(id, { note: val });
            if (_cfUnmatched[id]) _cfUnmatched[id].note = val.trim() || null;
            e.target.textContent = '✓ Gemt';
            setTimeout(() => { if (e.target) e.target.textContent = 'Gem note'; }, 1500);
        } catch (err) { alert('Kunne ikke gemme note: ' + err.message); }
    };

    // Kobl/split-toggle → vis allokerings-UI + hent evt. eksisterende allokeringer
    const allocBox = panel.querySelector('.cf-um-alloc');
    panel.querySelector('.cf-um-alloc-toggle').onclick = async (e) => {
        e.stopPropagation();
        allocBox.hidden = !allocBox.hidden;
        if (allocBox.hidden) return;
        try {
            const r = await fetchCfAllocations(id);
            _cfAllocDraft[id].existing = r.allocations || [];
        } catch { _cfAllocDraft[id].existing = []; }
        _cfRenderAllocLines(panel, id);
        const search = panel.querySelector('.cf-um-search');
        search.focus();
        search.oninput = () => {
            clearTimeout(_cfAllocSearchTimer);
            _cfAllocSearchTimer = setTimeout(() => _cfSearchTargets(panel, id, search.value.trim()), 220);
        };
    };

    // Gebyr-linje
    panel.querySelector('.cf-alloc-fee').onclick = (e) => {
        e.stopPropagation();
        _cfShowFeePicker(panel, id);
    };

    // Opret bon fra indbetaling (§2.E.3)
    const bonBox = panel.querySelector('.cf-um-bon');
    panel.querySelector('.cf-um-bon-toggle').onclick = async (e) => {
        e.stopPropagation();
        bonBox.hidden = !bonBox.hidden;
        if (bonBox.hidden) return;
        await _cfBuildBonForm(panel, id, tx);
    };

    // Gem allokering
    panel.querySelector('.cf-alloc-save').onclick = async (e) => {
        e.stopPropagation();
        const lines = _cfAllocDraft[id].lines;
        if (!lines.length) return;
        // En linje uden beløb (0) kan ikke gemmes — giv en tydelig besked frem for
        // en kryptisk 400 fra backend. Brugeren sætter et beløb eller fjerner linjen.
        if (lines.some(l => !Number(l.amount))) {
            alert('En eller flere linjer mangler et beløb. Sæt et beløb — eller fjern linjen med ✕ — før du gemmer.');
            return;
        }
        try {
            await createCfAllocations(id, lines.map(l => ({
                target_type: l.target_type, target_id: l.target_id, amount: l.amount
            })));
            _cfRenderOverblik();
        } catch (err) { alert('Kunne ikke gemme: ' + err.message); }
    };

    // Stop klik inde i panelet fra at lukke rækken
    panel.onclick = (e) => e.stopPropagation();
}

/** Σ allokeret (eksisterende + draft) og resterende uallokeret beløb. */
function _cfAllocRest(id) {
    const tx = _cfUnmatched[id] || { beloeb: 0 };
    const d = _cfAllocDraft[id] || { lines: [], existing: [] };
    const exist = (d.existing || []).reduce((s, a) => s + (a.amount || 0), 0);
    const staged = (d.lines || []).reduce((s, a) => s + (Number(a.amount) || 0), 0);
    return Math.round((tx.beloeb - exist - staged) * 100) / 100;
}

/** Render eksisterende + staged allokerings-linjer + rest-indikator. */
function _cfRenderAllocLines(panel, id) {
    const d = _cfAllocDraft[id] || { lines: [], existing: [] };
    const host = panel.querySelector('[data-lines]');
    const badge = (t, exp) => _cfBadgeHtml(t, exp);

    const existHtml = (d.existing || []).map(a => `
        <div class="cf-alloc-line cf-alloc-line-saved">
            ${badge(a.target_type, (a.amount || 0) < 0 && a.target_type === 'bon')}
            <div class="cf-alloc-line-lbl"><div>${_cfEsc(a.label || '')}</div><div class="cf-alloc-sub">${_cfEsc(a.sublabel || '')}</div></div>
            <input class="cf-alloc-amt cf-alloc-amt-saved" type="number" step="0.01" value="${a.amount}" data-edit-alloc="${a.id}" title="Ret beløb (gemmes ved Enter/tab)">
            <button class="cf-alloc-del" data-del-alloc="${a.id}" title="Fjern">✕</button>
        </div>
    `).join('');

    const stagedHtml = (d.lines || []).map((l, idx) => `
        <div class="cf-alloc-line">
            ${badge(l.target_type, l.expense)}
            <div class="cf-alloc-line-lbl"><div>${_cfEsc(l.label || '')}</div><div class="cf-alloc-sub">${_cfEsc(l.sublabel || '')}</div></div>
            <input class="cf-alloc-amt" type="number" step="0.01" value="${l.amount}" data-amt-idx="${idx}">
            <button class="cf-alloc-del" data-stage-idx="${idx}" title="Fjern">✕</button>
        </div>
    `).join('');

    host.innerHTML = existHtml + stagedHtml || '<div class="cf-um-hint">Søg og vælg mål nedenfor for at fordele beløbet.</div>';

    // Rest-indikator
    const rest = _cfAllocRest(id);
    const restEl = panel.querySelector('[data-rest]');
    restEl.textContent = 'Rest: ' + _cfFmt(rest);
    restEl.classList.toggle('cf-alloc-rest-zero', Math.abs(rest) < 0.01);
    restEl.classList.toggle('cf-alloc-rest-over', rest < -0.01);

    // Save aktiv når mindst én staged linje + ingen over-allokering
    const save = panel.querySelector('.cf-alloc-save');
    save.disabled = !(d.lines || []).length || rest < -0.01;

    // Wire beløbs-input
    host.querySelectorAll('.cf-alloc-amt').forEach(inp => {
        inp.onclick = (e) => e.stopPropagation();
        inp.oninput = () => {
            const i = +inp.getAttribute('data-amt-idx');
            d.lines[i].amount = Math.round((Number(inp.value) || 0) * 100) / 100;
            // opdater kun rest + save (undgå fuld re-render så fokus bevares)
            const rest2 = _cfAllocRest(id);
            restEl.textContent = 'Rest: ' + _cfFmt(rest2);
            restEl.classList.toggle('cf-alloc-rest-zero', Math.abs(rest2) < 0.01);
            restEl.classList.toggle('cf-alloc-rest-over', rest2 < -0.01);
            save.disabled = !d.lines.length || rest2 < -0.01;
        };
    });
    // Fjern staged
    host.querySelectorAll('[data-stage-idx]').forEach(btn => {
        btn.onclick = (e) => { e.stopPropagation(); d.lines.splice(+btn.getAttribute('data-stage-idx'), 1); _cfRenderAllocLines(panel, id); };
    });
    // Slet gemt allokering
    host.querySelectorAll('[data-del-alloc]').forEach(btn => {
        btn.onclick = async (e) => {
            e.stopPropagation();
            try {
                await deleteCfAllocation(btn.getAttribute('data-del-alloc'));
                const r = await fetchCfAllocations(id);
                d.existing = r.allocations || [];
                _cfRenderAllocLines(panel, id);
            } catch (err) { alert('Kunne ikke fjerne: ' + err.message); }
        };
    });
    // Ret beløb på en GEMT allokering (PATCH ved ændring/blur). Live-rest mens man
    // taster; gemmer ved 'change' (Enter/tab/blur).
    host.querySelectorAll('[data-edit-alloc]').forEach(inp => {
        inp.onclick = (e) => e.stopPropagation();
        inp.oninput = () => {
            const a = (d.existing || []).find(x => String(x.id) === inp.getAttribute('data-edit-alloc'));
            if (a) a.amount = Math.round((Number(inp.value) || 0) * 100) / 100;
            const rest2 = _cfAllocRest(id);
            restEl.textContent = 'Rest: ' + _cfFmt(rest2);
            restEl.classList.toggle('cf-alloc-rest-zero', Math.abs(rest2) < 0.01);
            restEl.classList.toggle('cf-alloc-rest-over', rest2 < -0.01);
        };
        inp.onchange = async () => {
            const allocId = inp.getAttribute('data-edit-alloc');
            const amount = Math.round((Number(inp.value) || 0) * 100) / 100;
            if (!amount) { inp.classList.add('cf-amt-invalid'); return; }
            inp.classList.remove('cf-amt-invalid');
            try {
                await patchCfAllocation(allocId, amount);
                const r = await fetchCfAllocations(id);
                d.existing = r.allocations || [];
                _cfRenderAllocLines(panel, id);
            } catch (err) { alert('Kunne ikke gemme beløb: ' + err.message); }
        };
    });
}

/** Universel søgning (bons + fakturaer) → resultatliste. Events kobles IKKE her —
 *  event-indtægt går altid via "Opret bon" (salgsbon), så det er i event-regnskabet. */
async function _cfSearchTargets(panel, id, q) {
    const host = panel.querySelector('.cf-um-target-list');
    if (!host) return;
    if (q.length < 1) { host.innerHTML = ''; return; }
    host.innerHTML = '<div class="cf-um-hint">Søger…</div>';
    let targets = [];
    try { targets = (await fetchCfMatchTargets(q)).targets || []; } catch { targets = []; }
    if (!targets.length) { host.innerHTML = '<div class="cf-um-hint">Ingen mål matcher.</div>'; return; }
    host.innerHTML = targets.map((t, i) => `
        <div class="cf-um-target" data-tgt="${i}">
            ${_cfBadgeHtml(t.type, t.expense)}
            <div class="cf-alloc-line-lbl"><div>${_cfEsc(t.label || '')}</div><div class="cf-alloc-sub">${_cfEsc(t.sublabel || '')}</div></div>
            <span class="cf-alloc-amt-fixed">${t.amount != null ? _cfFmt(t.amount) : ''}</span>
        </div>
    `).join('');
    host.querySelectorAll('.cf-um-target').forEach(row => {
        row.onclick = (e) => {
            e.stopPropagation();
            const t = targets[+row.getAttribute('data-tgt')];
            host.innerHTML = '';
            panel.querySelector('.cf-um-search').value = '';
            _cfAddAllocTarget(panel, id, t);
        };
    });
}

/** Tilføj et mål som staged allokerings-linje. Udgifts-bons (negativ) indsættes
 *  med deres negative beløb (fradrag); øvrige med resterende beløb. */
function _cfAddAllocTarget(panel, id, t) {
    const d = _cfAllocDraft[id];
    if (d.lines.some(l => l.target_type === t.type && String(l.target_id) === String(t.id))) return;
    const isExpense = t.expense || (t.amount != null && t.amount < 0);
    const rest = _cfAllocRest(id);
    let amount;
    if (isExpense) {
        amount = Math.round((t.amount || 0) * 100) / 100;      // negativ udgift → fradrag
    } else if (t.amount != null && t.amount > 0) {
        amount = Math.round(t.amount * 100) / 100;             // bonnens/fakturaens eget beløb → auto-fradrag fra resten
    } else {
        amount = rest > 0.01 ? rest : 0;                       // ukendt beløb (event/uprissat bon) → resten
    }
    d.lines.push({
        target_type: t.type, target_id: t.id, label: t.label, sublabel: t.sublabel, amount,
        expense: isExpense,
    });
    _cfRenderAllocLines(panel, id);
}

/** Justerings-vælger (+/−) → tilføjer en linje der dækker resten (begge veje:
 *  gebyr/afgift negativt, levering/drikkepenge positivt). Default = den aktuelle
 *  rest, så ét klik balancerer. */
function _cfShowFeePicker(panel, id) {
    const host = panel.querySelector('.cf-um-target-list');
    const rest = _cfAllocRest(id);
    host.innerHTML = _CF_FEE_KINDS.map((f, i) => `
        <div class="cf-um-target" data-fee="${i}">
            <span class="cf-alloc-badge" style="background:${_CF_TARGET_BADGE.fee.bg}">Just.</span>
            <div class="cf-alloc-line-lbl"><div>${f.label}</div><div class="cf-alloc-sub">fylder resten (${_cfFmt(rest)})</div></div>
        </div>
    `).join('');
    host.querySelectorAll('.cf-um-target').forEach(row => {
        row.onclick = (e) => {
            e.stopPropagation();
            const f = _CF_FEE_KINDS[+row.getAttribute('data-fee')];
            const d = _cfAllocDraft[id];
            const r = _cfAllocRest(id);
            // Default = resten (uanset fortegn) så linjen balancerer i ét klik.
            d.lines.push({ target_type: 'fee', target_id: f.id, label: f.label, sublabel: '', amount: Math.abs(r) > 0.01 ? r : 0 });
            host.innerHTML = '';
            _cfRenderAllocLines(panel, id);
        };
    });
}

/** §2.E.3 — formular: opret salgsbon fra en indbetaling. */
async function _cfBuildBonForm(panel, id, tx) {
    const box = panel.querySelector('.cf-um-bon');
    _cfBonDraft[id] = { lines: [{ name: 'Direkte salg', quantity: 1, amount: tx.beloeb, grocy_recipe_id: null, category: null }] };
    // Alle events i dropdownen (så man altid kan vælge det rigtige), men event(s)
    // hvis periode overlapper indbetalingens dato forvælges + markeres "samme dato".
    // Grocy-opskrifter hentes parallelt til menu-autocomplete på linjerne.
    let allEvents = [], overlapIds = new Set();
    try {
        const [all, onDate] = await Promise.all([
            fetchEventsList().catch(() => ({ events: [] })),
            fetchCfEventsOnDate(tx.dato).catch(() => ({ events: [] })),
            _cfLoadRecipes(),
        ]);
        allEvents = all.events || [];
        overlapIds = new Set((onDate.events || []).map(e => String(e.id)));
    } catch { allEvents = []; }
    const preselect = allEvents.find(e => overlapIds.has(String(e.id)));
    const evtOptions = '<option value="">Ingen / standalone</option>' +
        allEvents.map(e => `<option value="${e.id}">${_cfEsc(e.name)}${overlapIds.has(String(e.id)) ? ' · samme dato' : ''}</option>`).join('');
    const payOptions = _CF_PAY_OPTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    box.innerHTML = `
        <div class="cf-bon-hint">Opretter BETALT salgsbon${preselect ? ' (event forvalgt fra dato)' : ''} + kobler indbetalingen til den.</div>
        <div class="cf-bon-row">
            <label>Event</label>
            <select class="cf-bon-event">${evtOptions}</select>
        </div>
        <div class="cf-bon-row">
            <label>Betaling</label>
            <select class="cf-bon-pay">${payOptions}</select>
        </div>
        <div class="cf-bon-lines" data-bon-lines></div>
        <button class="cf-um-btn cf-bon-addline">+ linje</button>
        <div class="cf-bon-row cf-bon-fee-row">
            <label>Gebyr/afgift</label>
            <input class="cf-bon-fee-amt" type="number" step="0.01" placeholder="0 (valgfrit, negativt)">
            <button class="cf-um-btn cf-bon-fee-rest" type="button" title="Fyld med resten (brutto − netto = afgift/gebyr)">= rest</button>
        </div>
        <div class="cf-bon-foot">
            <span class="cf-bon-sum"></span>
            <button class="cf-um-btn cf-um-btn-primary cf-bon-create">Opret bon</button>
        </div>
    `;
    if (preselect) box.querySelector('.cf-bon-event').value = String(preselect.id);

    box.querySelector('.cf-bon-addline').onclick = (e) => {
        e.stopPropagation();
        _cfBonDraft[id].lines.push({ name: '', quantity: 1, amount: 0, grocy_recipe_id: null, category: null });
        _cfRenderBonLines(panel, id, tx);
    };
    box.querySelector('.cf-bon-fee-amt').oninput = () => _cfUpdateBonSum(panel, id, tx);
    // "= rest": fyld gebyr/afgift med differencen brutto-linjer − netto-indbetaling
    // (fx Tivoli 10% afgift + Zettle-gebyr), så Σ rammer indbetalingen.
    box.querySelector('.cf-bon-fee-rest').onclick = (e) => {
        e.stopPropagation();
        const linesSum = _cfBonDraft[id].lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
        const fee = Math.round((tx.beloeb - linesSum) * 100) / 100;  // negativ når brutto > netto
        const feeEl = box.querySelector('.cf-bon-fee-amt');
        feeEl.value = fee < 0 ? fee : 0;
        _cfUpdateBonSum(panel, id, tx);
    };
    box.querySelector('.cf-bon-create').onclick = async (e) => {
        e.stopPropagation();
        const eventId = box.querySelector('.cf-bon-event').value || null;
        const payment = box.querySelector('.cf-bon-pay').value;
        const feeRaw = Number(box.querySelector('.cf-bon-fee-amt').value);
        const lines = _cfBonDraft[id].lines.filter(l => Number(l.amount) > 0)
            .map(l => ({
                name: l.name || 'Direkte salg', quantity: Number(l.quantity) || 1, amount: Number(l.amount),
                grocy_recipe_id: l.grocy_recipe_id || null, category: l.category || null,
                cost_price: l.cost_price ?? null, co2e: l.co2e ?? null,
            }));
        if (!lines.length) { alert('Mindst én linje med beløb > 0'); return; }
        const body = { transaction_id: id, event_id: eventId ? Number(eventId) : null, payment_type: payment, lines };
        if (Number.isFinite(feeRaw) && feeRaw < 0) body.fee = { kind: payment === 'mobilepay' ? 'mobilepay' : 'zettle', amount: feeRaw };
        try {
            const r = await createBonFromCfTx(body);
            _cfRenderOverblik();
            setTimeout(() => alert(`${r.created ? 'Bon oprettet' : 'Tilføjet til eventets salgsbon'}: #${r.bon_number}`
                + (r.expense_bon_id ? '\nAfgift/gebyr bogført som event-udgift.' : '')), 50);
        } catch (err) { alert('Kunne ikke oprette bon: ' + err.message); }
    };

    _cfRenderBonLines(panel, id, tx);
}

function _cfRenderBonLines(panel, id, tx) {
    const host = panel.querySelector('[data-bon-lines]');
    const lines = _cfBonDraft[id].lines;
    host.innerHTML = lines.map((l, i) => {
        const hint = l.grocy_recipe_id
            ? `✓ Grocy: ${_cfEsc(l.category || '')}${l._festival ? ' · ref. ' + _cfFmt(l._festival) + '/stk' : ''}`
            : '';
        return `
        <div class="cf-bon-line">
            <input class="cf-bon-line-name" type="text" autocomplete="off" placeholder="Varenavn / Grocy-menu" value="${_cfEsc(l.name)}" data-bl-name="${i}">
            <input class="cf-bon-line-qty" type="number" min="1" step="1" value="${l.quantity || 1}" title="Antal solgt" data-bl-qty="${i}">
            <input class="cf-bon-line-amt" type="number" step="0.01" value="${l.amount}" title="Beløb (total, inkl. moms)" data-bl-amt="${i}">
            ${lines.length > 1 ? `<button class="cf-alloc-del" data-bl-del="${i}">✕</button>` : '<span style="width:18px"></span>'}
        </div>
        <div class="cf-recipe-results" data-bl-res="${i}"></div>
        <div class="cf-bon-line-hint" data-bl-hint="${i}">${hint}</div>`;
    }).join('');

    host.querySelectorAll('[data-bl-name]').forEach(inp => {
        const i = +inp.getAttribute('data-bl-name');
        inp.onclick = (e) => e.stopPropagation();
        inp.onfocus = () => _cfRenderRecipeSuggestions(panel, id, tx, i, inp.value);
        inp.oninput = () => {
            lines[i].name = inp.value;
            const rec = _cfRecipeByName ? _cfRecipeByName.get(inp.value.trim().toLowerCase()) : null;
            if (rec) _cfApplyRecipeToLine(panel, id, tx, i, rec);
            else _cfClearRecipeFromLine(panel, id, i);
            _cfRenderRecipeSuggestions(panel, id, tx, i, inp.value);
        };
        inp.onblur = () => setTimeout(() => {
            const r = host.querySelector(`[data-bl-res="${i}"]`);
            if (r) { r.classList.remove('open'); r.innerHTML = ''; }
        }, 160);
    });
    host.querySelectorAll('[data-bl-qty]').forEach(inp => {
        inp.onclick = (e) => e.stopPropagation();
        inp.oninput = () => { lines[+inp.getAttribute('data-bl-qty')].quantity = Number(inp.value) || 1; };
    });
    host.querySelectorAll('[data-bl-amt]').forEach(inp => {
        inp.onclick = (e) => e.stopPropagation();
        inp.oninput = () => { lines[+inp.getAttribute('data-bl-amt')].amount = Number(inp.value) || 0; _cfUpdateBonSum(panel, id, tx); };
    });
    host.querySelectorAll('[data-bl-del]').forEach(btn => {
        btn.onclick = (e) => { e.stopPropagation(); lines.splice(+btn.getAttribute('data-bl-del'), 1); _cfRenderBonLines(panel, id, tx); };
    });
    _cfUpdateBonSum(panel, id, tx);
}

/** Sæt en valgt Grocy-opskrift på en linje (delt af klik + eksakt-navn-match). */
function _cfApplyRecipeToLine(panel, id, tx, i, rec) {
    const host = panel.querySelector('[data-bon-lines]');
    const line = _cfBonDraft[id].lines[i];
    line.grocy_recipe_id = rec.id;
    line.category = rec.category || null;
    line.cost_price = rec.cost_price ?? null;
    line.co2e = rec.co2e ?? null;
    line._festival = _cfRecipeFestival(rec);
    // Beløb-feltet er linjens TOTAL (fx fra Zettle) — det forudfyldes IKKE fra
    // Grocy-prisen (event-prisen afviger ofte). Grocy-stykprisen vises kun som hint.
    const hintEl = host.querySelector(`[data-bl-hint="${i}"]`);
    if (hintEl) hintEl.innerHTML = `✓ Grocy: ${_cfEsc(rec.category || '')}${line._festival ? ' · ref. ' + _cfFmt(line._festival) + '/stk' : ''}`;
}

function _cfClearRecipeFromLine(panel, id, i) {
    const line = _cfBonDraft[id].lines[i];
    line.grocy_recipe_id = null; line.category = null;
    line.cost_price = null; line.co2e = null; line._festival = null;
    const hintEl = panel.querySelector(`[data-bon-lines] [data-bl-hint="${i}"]`);
    if (hintEl) hintEl.innerHTML = '';
}

/** Custom menu-dropdown (bredere end input) der viser navn + kategori, så slider
 *  og sandwich kan skelnes (native datalist afkortede til input-bredden). */
function _cfRenderRecipeSuggestions(panel, id, tx, i, query) {
    const host = panel.querySelector('[data-bon-lines]');
    const box = host.querySelector(`[data-bl-res="${i}"]`);
    if (!box) return;
    const recipes = _cfRecipeCache || [];
    if (!recipes.length) { box.classList.remove('open'); box.innerHTML = ''; return; }
    const q = (query || '').trim().toLowerCase();
    const matches = (q ? recipes.filter(r => r.name.toLowerCase().includes(q)) : recipes).slice(0, 30);
    if (!matches.length) { box.classList.remove('open'); box.innerHTML = ''; return; }
    box.innerHTML = matches.map((r, k) => `
        <div class="cf-recipe-opt" data-ri="${k}">
            <span class="cf-recipe-opt-name">${_cfEsc(r.name)}</span>
            <span class="cf-recipe-opt-cat">${_cfEsc(r.category || '')}</span>
        </div>`).join('');
    box.classList.add('open');
    box.querySelectorAll('.cf-recipe-opt').forEach(opt => {
        // mousedown preventDefault → input mister ikke fokus før klikket registreres
        opt.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
        opt.onclick = (e) => {
            e.stopPropagation();
            const rec = matches[+opt.getAttribute('data-ri')];
            _cfBonDraft[id].lines[i].name = rec.name;
            const nameEl = host.querySelector(`[data-bl-name="${i}"]`);
            if (nameEl) nameEl.value = rec.name;
            _cfApplyRecipeToLine(panel, id, tx, i, rec);
            box.classList.remove('open'); box.innerHTML = '';
        };
    });
}

function _cfUpdateBonSum(panel, id, tx) {
    const lines = _cfBonDraft[id].lines;
    const linesSum = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    const fee = Number(panel.querySelector('.cf-bon-fee-amt')?.value) || 0;
    const alloc = Math.round((linesSum + fee) * 100) / 100;
    const diff = Math.round((tx.beloeb - alloc) * 100) / 100;
    const el = panel.querySelector('.cf-bon-sum');
    const over = alloc > tx.beloeb + 0.01;
    el.innerHTML = `Linjer ${_cfFmt(linesSum)}${fee ? ' · gebyr ' + _cfFmt(fee) : ''} = <strong>${_cfFmt(alloc)}</strong>` +
        (Math.abs(diff) < 0.01 ? ' ✓' : ` · rest ${_cfFmt(diff)}`);
    el.classList.toggle('cf-bon-sum-over', over);
    const btn = panel.querySelector('.cf-bon-create');
    if (btn) btn.disabled = over || linesSum <= 0;
}

/* ── Weekly chart ── */
function _cfBuildWeeklyChart(weeks) {
    const container = document.getElementById('cfChartBars');
    if (!container) return;
    container.innerHTML = '';

    const maxVal = Math.max(1, ...weeks.map(w => w.received + w.expected + w.overdue));

    weeks.forEach(w => {
        const grp = document.createElement('div');
        grp.className = 'cf-bar-group';

        const total = w.received + w.expected + w.overdue;
        if (total === 0) {
            const b = document.createElement('div');
            b.style.cssText = 'height:2px;background:#f5f4f2;border-radius:2px;width:100%';
            grp.appendChild(b);
        } else {
            if (w.overdue > 0) {
                const b = document.createElement('div');
                b.className = 'cf-bar overdue';
                b.style.height = Math.max(4, (w.overdue / maxVal) * 116) + 'px';
                b.title = `Forfalden: ${_cfFmt(w.overdue)}`;
                grp.appendChild(b);
            }
            if (w.received > 0) {
                const b = document.createElement('div');
                b.className = 'cf-bar received';
                b.style.height = Math.max(4, (w.received / maxVal) * 116) + 'px';
                b.title = `Modtaget: ${_cfFmt(w.received)}`;
                grp.appendChild(b);
            }
            if (w.expected > 0) {
                const b = document.createElement('div');
                b.className = 'cf-bar expected';
                b.style.height = Math.max(4, (w.expected / maxVal) * 116) + 'px';
                b.title = `Forventet: ${_cfFmt(w.expected)}`;
                grp.appendChild(b);
            }
        }

        const lbl = document.createElement('div');
        lbl.className = 'cf-bar-label';
        lbl.textContent = w.label;
        grp.appendChild(lbl);

        container.appendChild(grp);
    });
}

/* ── Tab button med count + total ── */
function _cfFmtShort(n) {
    if (n == null) return '–';
    const abs = Math.abs(n);
    if (abs >= 1_000_000) return (n / 1_000_000).toLocaleString('da-DK', { maximumFractionDigits: 1 }) + ' mkr';
    if (abs >= 10_000)   return Math.round(n / 1000).toLocaleString('da-DK') + ' kkr';
    if (abs >= 1000)     return (n / 1000).toLocaleString('da-DK', { maximumFractionDigits: 1 }) + ' kkr';
    return Math.round(n) + ' kr';
}

function _cfRenderTabBtn(tab, label, summary) {
    const s = summary?.[tab];
    const active = _cfInvTab === tab ? 'active' : '';
    const meta = s
        ? `<span class="cf-tab-meta">${s.count} · ${_cfFmtShort(s.total)}</span>`
        : '';
    return `<button class="cf-inv-tab ${active}" data-tab="${tab}">${label}${meta}</button>`;
}

/* ── Sum-footer på listen ── */
function _cfBuildInvoiceFooter(summary, tab) {
    const el = document.getElementById('cfInvFooter');
    if (!el) return;
    const s = summary?.[tab];
    if (!s) { el.innerHTML = ''; return; }
    el.innerHTML = `
        <div class="cf-inv-footer-row">
            <span>I alt for <strong>${tab === 'alle' ? 'Alle' : tab === 'udestaaende' ? 'Udestående (ikke forfaldne)' : tab === 'forfaldne' ? 'Forfaldne' : tab === 'sandsynlig' ? 'Sandsynlig betalt' : 'Betalt'}</strong>:</span>
            <span class="cf-inv-footer-sum">${s.count} stk · ${_cfFmt(s.total)}</span>
        </div>
    `;
}

/* ── Re-render tab-knapper med opdaterede tællere ── */
function _cfRefreshTabs(summary) {
    const container = document.getElementById('cfInvFilters');
    if (!container) return;
    container.innerHTML = `
        ${_cfRenderTabBtn('alle', 'Alle', summary)}
        ${_cfRenderTabBtn('udestaaende', 'Udestående', summary)}
        ${_cfRenderTabBtn('forfaldne', 'Forfaldne', summary)}
        ${_cfRenderTabBtn('sandsynlig', 'Sandsynlig betalt', summary)}
        ${_cfRenderTabBtn('betalt', 'Betalt', summary)}
    `;
    // Re-wire click-handlers
    container.querySelectorAll('.cf-inv-tab').forEach(btn => {
        btn.onclick = async () => {
            _cfInvTab = btn.dataset.tab;
            try {
                const inv = await fetchCfInvoices(_cfInvTab);
                _cfRefreshTabs(inv.summary);
                _cfBuildInvoiceRows(inv.rows, _cfInvTab);
                _cfBuildInvoiceFooter(inv.summary, _cfInvTab);
                // Vis/skjul bulk-knap baseret på aktiv tab.
                const bulkBtn = document.getElementById('cfBulkBtn');
                if (bulkBtn) bulkBtn.style.display = _cfInvTab === 'forfaldne' ? '' : 'none';
            } catch (err) { /* ignore */ }
        };
    });
}

/* ── Invoice rows ── */
function _cfBuildInvoiceRows(rows, tab) {
    const container = document.getElementById('cfInvRows');
    if (!container) return;

    if (rows.length === 0) {
        container.innerHTML = '<div style="padding:20px;text-align:center;color:#8a8580;font-size:13px">Ingen fakturaer i denne kategori</div>';
        return;
    }

    // I "Sandsynlig betalt"-fanen viser vi ekspanderet match- + bon-info per
    // række så brugeren kan bekræfte/forkaste uden at åbne edit-modalen.
    const expanded = tab === 'sandsynlig';
    // I "Forfaldne"-fanen viser vi inline quick-actions per række så brugeren
    // hurtigt kan rydde fakturaer der reelt er betalt i e-conomic men hænger
    // som forfaldne i Bon v2 (manglende sync).
    const quickActions = tab === 'forfaldne';

    container.innerHTML = rows.map(inv => {
        const days = _cfDaysUntil(inv.forfald);
        let pillClass, pillText;
        if (inv.betalt) {
            pillClass = 'cf-pill-betalt'; pillText = 'Betalt';
        } else if (days < 0) {
            pillClass = 'cf-pill-forfalden'; pillText = 'Forfalden';
        } else if (days <= 7) {
            pillClass = 'cf-pill-udestaaende'; pillText = 'Udestående';
        } else {
            pillClass = 'cf-pill-udestaaende'; pillText = 'Udestående';
        }

        const dueClass = days < 0 && !inv.betalt ? 'overdue' : days <= 7 && !inv.betalt ? 'soon' : '';

        const classList = [
            'cf-inv-row',
            expanded ? 'cf-inv-row-expanded' : '',
            quickActions ? 'cf-inv-row-quick' : ''
        ].filter(Boolean).join(' ');

        const quickHtml = quickActions
            ? `<div class="cf-quick-actions">
                 <button class="cf-quick-btn cf-quick-confirm" data-inv-id="${inv.id}" title="Bekræft som betalt">✓ Betalt</button>
                 ${inv.bon_id ? `<button class="cf-quick-btn cf-quick-open" data-bon-id="${inv.bon_id}" title="Åbn bon">→</button>` : ''}
               </div>`
            : '';

        return `
        <div class="${classList}" data-inv-id="${inv.id}">
            <div class="cf-inv-main">
                <div class="cf-inv-num">#${inv.id}</div>
                <div class="cf-inv-customer">${inv.kunde}${inv.betalingstype ? `<span>${inv.betalingstype}</span>` : ''}</div>
                <div class="cf-inv-amount">${_cfFmt(inv.beloeb)}</div>
                <div class="cf-inv-due ${dueClass}">${_cfFmtDate(inv.forfald)}</div>
                <div class="cf-inv-status-cell">
                    <span class="cf-pill ${pillClass}">${pillText}</span>
                    ${quickHtml}
                </div>
            </div>
            ${expanded ? _cfRenderMatchPanel(inv) : ''}
        </div>`;
    }).join('');

    // Click main-row → edit (men ikke når man klikker på quick-action-knapper
    // eller i ekspander-sektionen).
    container.querySelectorAll('.cf-inv-row').forEach(row => {
        const main = row.querySelector('.cf-inv-main');
        if (main) main.onclick = (ev) => {
            if (ev.target.closest('.cf-quick-actions')) return;
            _cfShowInvForm(_cfEl, row.dataset.invId);
        };
    });

    // Wire knap-handlers i ekspanderede rækker.
    if (expanded) _cfWireMatchActions(container);
    // Wire quick-action-knapper i forfaldne-rækker.
    if (quickActions) {
        _cfWireQuickActions(container);
        // Hent bank-match-forslag og injicér inline under hver forfalden faktura
        // der har et muligt match. Asynkront + non-blocking — listen vises straks,
        // forslagene popper ind et øjeblik efter.
        _cfApplySuggestions(container);
    }
}

/* ── Bank-match-forslag på forfaldne fakturaer ──
 *
 * Henter GET /suggest-matches og indsætter en fremhævet linje under hver
 * forfalden faktura med et muligt umatchet bankindbetaling. Ét klik på
 * "✓ Match & betalt" kobler tx'en til fakturaen (markerer betalt) + bekræfter
 * (synker bon-status til BETALT). Gør det muligt at dobbelttjekke forfaldne mod
 * banken uden at have netbanken åben ved siden af.
 */
async function _cfApplySuggestions(container) {
    let data;
    try {
        data = await fetchCfSuggestMatches();
    } catch { return; }
    const suggestions = data?.suggestions || {};
    // Containeren kan være blevet re-rendret mens kaldet kørte — tjek at vi
    // stadig er i forfaldne-fanen før vi injicerer.
    if (_cfInvTab !== 'forfaldne') return;

    Object.entries(suggestions).forEach(([invId, s]) => {
        const row = container.querySelector(`.cf-inv-row[data-inv-id="${CSS.escape(invId)}"]`);
        if (!row || row.querySelector('.cf-suggest-line')) return;

        const reason = s.has_invoice_nr
            ? 'fakturanr. i teksten'
            : s.amount_exact ? 'samme beløb' : 'beløb passer ca.';
        const line = document.createElement('div');
        line.className = 'cf-suggest-line';
        line.innerHTML = `
            <span class="cf-suggest-icon">💡</span>
            <span class="cf-suggest-text">
                Muligt match: ${_cfFmtDate(s.dato)} · ${_cfFmt(s.beloeb)} ·
                <span class="cf-suggest-memo" title="${_cfEsc(s.tekst)}">"${_cfEsc(_cfTruncate(s.tekst, 50))}"</span>
                <span class="cf-suggest-reason">${reason}</span>
            </span>
            <button class="cf-quick-btn cf-suggest-apply" data-inv-id="${_cfEsc(invId)}" data-tx-id="${s.tx_id}">✓ Match &amp; betalt</button>
        `;
        row.appendChild(line);
    });

    container.querySelectorAll('.cf-suggest-apply').forEach(btn => {
        btn.onclick = async (ev) => {
            ev.stopPropagation();
            const invId = btn.dataset.invId;
            const txId = btn.dataset.txId;
            btn.disabled = true;
            try {
                await matchCfTransaction(txId, invId);
                const res = await confirmCfInvoicePaid(invId);
                _cfShowToast(res.bon_status_changed
                    ? `Faktura #${invId} matchet & betalt · bon flyttet til BETALT`
                    : `Faktura #${invId} matchet & betalt`);
                await _cfReloadInvoices();
            } catch (err) {
                _cfShowToast(`Fejl: ${err.message}`, true);
                btn.disabled = false;
            }
        };
    });
}

/* ── Wire quick-actions (Forfaldne-fanen) ── */
function _cfWireQuickActions(container) {
    container.querySelectorAll('.cf-quick-confirm').forEach(btn => {
        btn.onclick = async (ev) => {
            ev.stopPropagation();
            const id = btn.dataset.invId;
            if (!confirm(`Bekræft faktura #${id} som betalt?\n\nFakturaen flyttes til Betalt. Hvis fakturaen er koblet til en bon i Bon v2, flyttes bonens status også til BETALT.`)) return;
            btn.disabled = true;
            try {
                const res = await confirmCfInvoicePaid(id);
                _cfShowToast(res.bon_status_changed
                    ? `Faktura #${id} bekræftet · bon flyttet til BETALT`
                    : `Faktura #${id} bekræftet`);
                await _cfReloadInvoices();
            } catch (err) {
                _cfShowToast(`Fejl: ${err.message}`, true);
                btn.disabled = false;
            }
        };
    });
    container.querySelectorAll('.cf-quick-open').forEach(btn => {
        btn.onclick = (ev) => {
            ev.stopPropagation();
            const bonId = parseInt(btn.dataset.bonId);
            if (_cfOpts.openDrawer) _cfOpts.openDrawer(bonId);
            else window.location.href = `/office/?bon=${bonId}`;
        };
    });
}

/* ── Bulk-confirm modal (Forfaldne) ── */
function _cfShowBulkModal() {
    // Fjern evt. eksisterende modal
    document.getElementById('cfBulkModal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'cfBulkModal';
    overlay.className = 'cf-modal-overlay';
    overlay.innerHTML = `
        <div class="cf-modal">
            <div class="cf-modal-header">
                <h3>Marker mange forfaldne som betalt</h3>
                <button class="cf-modal-close" type="button" aria-label="Luk">×</button>
            </div>
            <div class="cf-modal-body">
                <p class="cf-modal-hint">
                    Brug denne når Bon v2 og e-conomic ikke er synkroniserede,
                    og du ved at gamle forfaldne fakturaer reelt er betalt.
                </p>
                <label class="cf-modal-field">
                    <span>Marker som betalt hvis forfalden i mere end</span>
                    <span class="cf-modal-field-row">
                        <input type="number" id="cfBulkDays" value="45" min="0" step="1">
                        <span>dage</span>
                        <button class="cf-btn cf-btn-ghost" id="cfBulkPreviewBtn" type="button" style="font-size:12px;padding:5px 12px;margin-left:8px">Vis preview</button>
                    </span>
                </label>
                <div id="cfBulkPreview"></div>
            </div>
            <div class="cf-modal-actions">
                <button class="cf-btn cf-btn-ghost" id="cfBulkCancelBtn" type="button">Annullér</button>
                <button class="cf-btn cf-btn-primary" id="cfBulkConfirmBtn" type="button" disabled>Bekræft og marker som betalt</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const daysInput = overlay.querySelector('#cfBulkDays');
    const previewBtn = overlay.querySelector('#cfBulkPreviewBtn');
    const confirmBtn = overlay.querySelector('#cfBulkConfirmBtn');
    const previewEl = overlay.querySelector('#cfBulkPreview');
    let lastPreview = null;

    const close = () => overlay.remove();
    overlay.querySelector('.cf-modal-close').onclick = close;
    overlay.querySelector('#cfBulkCancelBtn').onclick = close;
    overlay.onclick = (ev) => { if (ev.target === overlay) close(); };

    // Auto-preview ved load
    const runPreview = async () => {
        const days = parseInt(daysInput.value);
        if (!Number.isFinite(days) || days < 0) {
            previewEl.innerHTML = '<div class="cf-modal-err">Angiv et positivt heltal.</div>';
            confirmBtn.disabled = true;
            return;
        }
        previewBtn.disabled = true;
        previewEl.innerHTML = '<div class="cf-modal-loading">Henter preview…</div>';
        try {
            const res = await bulkConfirmCfInvoicesPaid(days, true);
            lastPreview = res;
            if (res.count === 0) {
                previewEl.innerHTML = `<div class="cf-modal-empty">Ingen forfaldne fakturaer ældre end ${days} dage.</div>`;
                confirmBtn.disabled = true;
            } else {
                const bonCount = res.invoices.filter(i => i.has_bon).length;
                previewEl.innerHTML = `
                    <div class="cf-modal-preview-summary">
                        <strong>${res.count}</strong> fakturaer · <strong>${_cfFmt(res.total)}</strong>
                        ${bonCount > 0 ? `<br><span class="cf-modal-sub">Heraf <strong>${bonCount}</strong> koblet til bons i Bon v2 — bon-status flyttes også til BETALT.</span>` : ''}
                    </div>
                    <div class="cf-modal-preview-list">
                        ${res.invoices.slice(0, 50).map(i => `
                            <div class="cf-modal-preview-row">
                                <span class="cf-modal-prev-id">#${i.id}</span>
                                <span class="cf-modal-prev-kunde">${_cfEsc(i.kunde)}</span>
                                <span class="cf-modal-prev-due">${_cfFmtDate(i.forfald)}</span>
                                <span class="cf-modal-prev-amount">${_cfFmt(i.beloeb)}</span>
                            </div>
                        `).join('')}
                        ${res.invoices.length > 50 ? `<div class="cf-modal-prev-more">+ ${res.invoices.length - 50} flere…</div>` : ''}
                    </div>
                `;
                confirmBtn.disabled = false;
            }
        } catch (err) {
            previewEl.innerHTML = `<div class="cf-modal-err">Fejl: ${err.message}</div>`;
            confirmBtn.disabled = true;
        } finally {
            previewBtn.disabled = false;
        }
    };
    previewBtn.onclick = runPreview;
    daysInput.onchange = () => { confirmBtn.disabled = true; previewEl.innerHTML = ''; };

    confirmBtn.onclick = async () => {
        if (!lastPreview || lastPreview.count === 0) return;
        const days = parseInt(daysInput.value);
        if (!confirm(`Marker ${lastPreview.count} fakturaer (${_cfFmt(lastPreview.total)}) som betalt?\n\nDe flyttes til Betalt-fanen. Tilknyttede bons i Bon v2 får status BETALT.\n\nDette kan ikke fortrydes samlet — du skal i givet fald markere dem som ubetalte enkeltvis.`)) return;
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Arbejder…';
        try {
            const res = await bulkConfirmCfInvoicesPaid(days, false);
            close();
            _cfShowToast(`${res.invoices_marked} fakturaer bekræftet${res.bon_status_changed > 0 ? ` · ${res.bon_status_changed} bons flyttet til BETALT` : ''}`);
            await _cfReloadInvoices();
        } catch (err) {
            _cfShowToast(`Fejl: ${err.message}`, true);
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Bekræft og marker som betalt';
        }
    };

    // Kør preview automatisk
    runPreview();
}

/* ── Render match + bon-info + actions for én række ── */
function _cfRenderMatchPanel(inv) {
    const matches = Array.isArray(inv.matches) ? inv.matches : [];
    const bonHtml = inv.bon_id
        ? `<div class="cf-mp-bon">
             🧾 Bon #${inv.bon_number ?? inv.bon_id}
             ${inv.bon_status_label ? `· <span class="cf-mp-status">${_cfEsc(inv.bon_status_label)}</span>` : ''}
             ${inv.bon_delivery_date ? `· leveret ${_cfFmtDate(inv.bon_delivery_date)}` : ''}
           </div>`
        : `<div class="cf-mp-bon cf-mp-bon-none">🧾 Manuelt oprettet faktura — ingen bon-kobling</div>`;

    // Top-3 mest relevante matches synlige, resten skjules bag disclosure.
    // Backend leverer allerede sorteret (conf DESC, dato DESC) — vi splitter
    // bare arrayet.
    const MAX_VISIBLE = 3;
    const visible = matches.slice(0, MAX_VISIBLE);
    const hidden = matches.slice(MAX_VISIBLE);
    const renderMatch = (m) => {
        const confClass = m.confidence >= 70 ? 'high' : m.confidence >= 50 ? 'med' : 'low';
        const txt = _cfTruncate(m.tekst, 80);
        return `<div class="cf-mp-match">
            🏦 ${_cfFmtDate(m.dato)} · ${_cfFmt(m.beloeb)} ·
            <span class="cf-mp-tekst" title="${_cfEsc(m.tekst)}">"${_cfEsc(txt)}"</span>
            <span class="cf-mp-conf cf-mp-conf-${confClass}">konf. ${m.confidence}</span>
        </div>`;
    };
    const matchesHtml = matches.length
        ? visible.map(renderMatch).join('') + (hidden.length
            ? `<details class="cf-mp-more">
                 <summary>+ ${hidden.length} ${hidden.length === 1 ? 'ældre match' : 'ældre matches'}</summary>
                 ${hidden.map(renderMatch).join('')}
               </details>`
            : '')
        : `<div class="cf-mp-match cf-mp-match-none">🏦 Intet bank-match endnu</div>`;

    return `
    <div class="cf-mp">
        ${matchesHtml}
        ${bonHtml}
        <div class="cf-mp-actions">
            <button class="cf-btn cf-btn-primary cf-mp-confirm" data-inv-id="${inv.id}">✓ Bekræft betalt</button>
            <button class="cf-btn cf-btn-ghost cf-mp-reject" data-inv-id="${inv.id}" ${matches.length ? '' : 'disabled'}>Endnu ikke betalt</button>
            ${inv.bon_id ? `<button class="cf-btn cf-btn-ghost cf-mp-open-bon" data-bon-id="${inv.bon_id}">Åbn bon →</button>` : ''}
        </div>
    </div>`;
}

/* ── Esc helpers ── */
function _cfEsc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _cfTruncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n) + '…' : s;
}

/* ── Wire confirm/reject/open-bon ── */
function _cfWireMatchActions(container) {
    container.querySelectorAll('.cf-mp-confirm').forEach(btn => {
        btn.onclick = async (ev) => {
            ev.stopPropagation();
            const id = btn.dataset.invId;
            btn.disabled = true;
            try {
                const res = await confirmCfInvoicePaid(id);
                _cfShowToast(res.bon_status_changed
                    ? `Faktura #${id} bekræftet · bon flyttet til BETALT`
                    : `Faktura #${id} bekræftet`);
                await _cfReloadInvoices();
            } catch (err) {
                _cfShowToast(`Fejl: ${err.message}`, true);
                btn.disabled = false;
            }
        };
    });
    container.querySelectorAll('.cf-mp-reject').forEach(btn => {
        btn.onclick = async (ev) => {
            ev.stopPropagation();
            const id = btn.dataset.invId;
            if (!confirm(`Marker faktura #${id} som endnu ikke betalt?\n\nFakturaen flyttes tilbage til "Forfaldne". Bank-matches nulstilles så transaktionerne kan matches mod andre fakturaer.`)) return;
            btn.disabled = true;
            try {
                await rejectCfInvoiceMatch(id);
                _cfShowToast(`#${id} markeret som endnu ikke betalt`);
                await _cfReloadInvoices();
            } catch (err) {
                _cfShowToast(`Fejl: ${err.message}`, true);
                btn.disabled = false;
            }
        };
    });
    container.querySelectorAll('.cf-mp-open-bon').forEach(btn => {
        btn.onclick = (ev) => {
            ev.stopPropagation();
            const bonId = parseInt(btn.dataset.bonId);
            if (_cfOpts.openDrawer) _cfOpts.openDrawer(bonId);
            else window.location.href = `/office/?bon=${bonId}`;
        };
    });
}

/* ── Reload listen + tabs efter handling ── */
async function _cfReloadInvoices() {
    const inv = await fetchCfInvoices(_cfInvTab);
    _cfRefreshTabs(inv.summary);
    _cfBuildInvoiceRows(inv.rows, _cfInvTab);
    _cfBuildInvoiceFooter(inv.summary, _cfInvTab);
    // Også opdater KPI-stripen øverst (saldo, udestående, forfaldne).
    try {
        const stats = await fetchCfStats();
        _cfRefreshKpiStrip(stats);
    } catch { /* ignore */ }
}

/* ── Lightweight toast ── */
function _cfShowToast(msg, isError) {
    let toast = document.getElementById('cfToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'cfToast';
        toast.className = 'cf-toast';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.toggle('cf-toast-error', !!isError);
    toast.classList.add('cf-toast-show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toast.classList.remove('cf-toast-show'), 3500);
}

/* ── Re-render metrics-strip uden full re-render af hele overblikket ── */
function _cfRefreshKpiStrip(stats) {
    const wrap = _cfEl?.querySelector('.cf-metrics');
    if (!wrap) return;
    const values = wrap.querySelectorAll('.cf-metric-value');
    if (values.length < 4) return;
    values[0].textContent = stats.saldo != null ? _cfFmt(stats.saldo) : '—';
    values[1].textContent = _cfFmt(stats.outstanding_total);
    values[2].textContent = _cfFmt(stats.overdue_total);
    values[3].textContent = _cfFmt(stats.expected_30d_total);
}

/* ── Invoice form ── */
async function _cfShowInvForm(el, editId) {
    const area = el.querySelector('#cfInvFormArea');
    if (!area) return;

    let inv = null;
    if (editId) {
        const data = await fetchCfInvoices('alle');
        inv = data.rows.find(r => r.id === editId);
    }

    area.innerHTML = `
    <div class="cf-inv-form">
        <label>Fakturanummer <input type="text" id="cfInvId" value="${inv ? inv.id : ''}" ${inv ? 'readonly' : ''}></label>
        <label>Kunde <input type="text" id="cfInvKunde" value="${inv ? inv.kunde : ''}"></label>
        <label>Beløb (kr) <input type="number" id="cfInvBeloeb" step="0.01" value="${inv ? inv.beloeb : ''}"></label>
        <label>Forfaldsdato <input type="date" id="cfInvForfald" value="${inv ? inv.forfald : ''}"></label>
        <label>Betalingstype
            <select id="cfInvType">
                <option value="">—</option>
                <option value="ean" ${inv?.betalingstype === 'ean' ? 'selected' : ''}>EAN</option>
                <option value="bank" ${inv?.betalingstype === 'bank' ? 'selected' : ''}>Bank</option>
                <option value="kontant" ${inv?.betalingstype === 'kontant' ? 'selected' : ''}>Kontant</option>
            </select>
        </label>
        <label>Noter <input type="text" id="cfInvNoter" value="${inv?.noter || ''}"></label>
        <div class="cf-inv-form-actions">
            ${inv ? `<button class="cf-btn cf-btn-danger" id="cfInvDel">Slet</button>` : ''}
            ${inv && !inv.betalt ? `<button class="cf-btn cf-btn-ghost" id="cfInvMarkPaid">Markér betalt</button>` : ''}
            <button class="cf-btn cf-btn-ghost" id="cfInvCancel">Annuller</button>
            <button class="cf-btn cf-btn-primary" id="cfInvSave">${inv ? 'Gem' : 'Opret'}</button>
        </div>
    </div>`;

    area.querySelector('#cfInvCancel').onclick = () => { area.innerHTML = ''; };

    area.querySelector('#cfInvSave').onclick = async () => {
        const data = {
            id: area.querySelector('#cfInvId').value.trim(),
            kunde: area.querySelector('#cfInvKunde').value.trim(),
            beloeb: parseFloat(area.querySelector('#cfInvBeloeb').value),
            forfald: area.querySelector('#cfInvForfald').value,
            betalingstype: area.querySelector('#cfInvType').value || null,
            noter: area.querySelector('#cfInvNoter').value.trim() || null
        };

        if (!data.id || !data.kunde || isNaN(data.beloeb) || !data.forfald) {
            alert('Udfyld venligst alle påkrævede felter');
            return;
        }

        try {
            if (inv) {
                await patchCfInvoice(inv.id, data);
            } else {
                await createCfInvoice(data);
            }
            area.innerHTML = '';
            _cfRenderOverblik();
        } catch (err) {
            alert('Fejl: ' + err.message);
        }
    };

    if (inv) {
        area.querySelector('#cfInvDel').onclick = async () => {
            if (!confirm(`Slet faktura #${inv.id}?`)) return;
            try {
                await deleteCfInvoice(inv.id);
                area.innerHTML = '';
                _cfRenderOverblik();
            } catch (err) { alert('Fejl: ' + err.message); }
        };

        const markBtn = area.querySelector('#cfInvMarkPaid');
        if (markBtn) {
            markBtn.onclick = async () => {
                try {
                    await patchCfInvoice(inv.id, { betalt: true, betalt_dato: new Date().toISOString().slice(0, 10) });
                    area.innerHTML = '';
                    _cfRenderOverblik();
                } catch (err) { alert('Fejl: ' + err.message); }
            };
        }
    }
}

/* ══════════════════════════════════════════════════════════
   TAB 2: ANALYSE
   ══════════════════════════════════════════════════════════ */

async function _cfRenderAnalyse() {
    const content = _cfEl.querySelector('#cfContent');
    content.innerHTML = '<div class="cf-empty"><div class="cf-empty-icon">⏳</div>Henter analysedata...</div>';

    try {
        const [analyse, payBehavior] = await Promise.all([
            fetchCfAnalyse(),
            fetchCfPaymentBehavior()
        ]);
        _cfAnalyseData = analyse;
        _cfBuildAnalyse(content, analyse, payBehavior);
    } catch (err) {
        content.innerHTML = `<div class="cf-empty"><div class="cf-empty-icon">⚠️</div>${err.message}</div>`;
    }
}

function _cfBuildAnalyse(el, data, payData) {
    const thisYear = new Date().getFullYear();
    const prevYear = thisYear - 1;
    const prev2Year = thisYear - 2;

    // YTD values for badges
    const ytdCur = data.ytd[thisYear];
    const ytdPrev = data.ytd[prevYear];
    const ytdPrev2 = data.ytd[prev2Year];

    const curMonth = new Date().getMonth();
    const curVal = ytdCur ? ytdCur[curMonth] || ytdCur.filter(v => v != null).pop() || 0 : 0;
    const prevVal = ytdPrev ? ytdPrev[curMonth] || 0 : 0;
    const prev2Val = ytdPrev2 ? ytdPrev2[curMonth] || 0 : 0;

    const delta1 = prevVal ? Math.round((curVal - prevVal) / prevVal * 100) : 0;
    const delta2 = prev2Val ? Math.round((curVal - prev2Val) / prev2Val * 100) : 0;

    el.innerHTML = `
        <!-- YTD Section -->
        <div class="cf-card">
            <div class="cf-card-title">
                Kumulativ omsætning — YTD (ex moms)
                <div class="cf-toggle-group">
                    <button class="cf-toggle-btn active" id="cfYtdKr">kr</button>
                    <button class="cf-toggle-btn" id="cfYtdSandwich">🥪</button>
                </div>
            </div>
            <div class="cf-ytd-badges">
                <div class="cf-ytd-badge" style="background:#f7f2d9">
                    <div class="cf-ytd-badge-label">${thisYear} YTD</div>
                    <div class="cf-ytd-badge-val" style="color:#8e631f">${curVal ? curVal.toLocaleString('da-DK') + 'k' : '—'}</div>
                </div>
                <div class="cf-ytd-badge" style="background:#e8f0f6">
                    <div class="cf-ytd-badge-label">${prevYear} ref.</div>
                    <div class="cf-ytd-badge-val" style="color:#4a6e96">${prevVal ? prevVal.toLocaleString('da-DK') + 'k' : '—'}</div>
                    <div class="cf-ytd-badge-delta" style="color:${delta1 >= 0 ? '#7a9c54' : '#bc3a3a'}">${delta1 >= 0 ? '+' : ''}${delta1}%</div>
                </div>
                <div class="cf-ytd-badge" style="background:#f5f4f2">
                    <div class="cf-ytd-badge-label">${prev2Year} ref.</div>
                    <div class="cf-ytd-badge-val">${prev2Val ? prev2Val.toLocaleString('da-DK') + 'k' : '—'}</div>
                    <div class="cf-ytd-badge-delta" style="color:${delta2 >= 0 ? '#7a9c54' : '#bc3a3a'}">${delta2 >= 0 ? '+' : ''}${delta2}%</div>
                </div>
            </div>
            <div class="cf-ytd-legend">
                <div class="cf-leg-item" id="cfLegCur" onclick="_cfToggleYtdRef('cur')">
                    <div class="cf-leg-line" style="background:#8e631f;height:3px"></div>${thisYear}
                </div>
                <div class="cf-leg-item" id="cfLegPrev" onclick="_cfToggleYtdRef('prev')">
                    <div class="cf-leg-line dashed" style="color:#4a6e96"></div>${prevYear}
                </div>
                <div class="cf-leg-item" id="cfLegPrev2" onclick="_cfToggleYtdRef('prevprev')">
                    <div class="cf-leg-line dashed" style="color:#8a8580"></div>${prev2Year}
                </div>
            </div>
            <canvas id="cfYtdCanvas"></canvas>
        </div>

        <!-- PAX Segments -->
        <div class="cf-card">
            <div class="cf-card-title">Pax-segmenter — omsætning (ex moms) &amp; ordrer</div>
            <div class="cf-pax-controls">
                <div class="cf-toggle-group" id="cfPaxPeriodTg">
                    <button class="cf-toggle-btn" onclick="_cfSetPaxPeriod('uge')">Uge</button>
                    <button class="cf-toggle-btn active" onclick="_cfSetPaxPeriod('maaned')">Måned</button>
                    <button class="cf-toggle-btn" onclick="_cfSetPaxPeriod('kvartal')">Kvartal</button>
                </div>
                <div class="cf-toggle-group" id="cfPaxViewTg">
                    <button class="cf-toggle-btn active" onclick="_cfSetPaxView('oversigt')">Oversigt</button>
                    <button class="cf-toggle-btn" onclick="_cfSetPaxView('enkelt')">Enkelt</button>
                </div>
                <div class="cf-period-nav" id="cfPeriodNav" style="display:none">
                    <button class="cf-period-nav-btn" onclick="_cfNavPeriod(-1)">‹</button>
                    <span class="cf-period-nav-label" id="cfNavLabel"></span>
                    <button class="cf-period-nav-btn" onclick="_cfNavPeriod(1)">›</button>
                </div>
                <div class="cf-ref-toggle" id="cfRefToggle" style="display:none" onclick="_cfToggleRef()">
                    <div class="cf-ref-dot"></div>Vis forrige år
                </div>
                <div class="cf-toggle-group" id="cfPaxUnitTg">
                    <button class="cf-toggle-btn active" onclick="_cfSetPaxUnit('kr')">kr</button>
                    <button class="cf-toggle-btn" onclick="_cfSetPaxUnit('pax')">pax</button>
                </div>
            </div>
            <div class="cf-pax-grid">
                <div>
                    <div class="cf-pax-chart-title">Omsætning per segment (ex moms)</div>
                    <div class="cf-pax-bars" id="cfRevChart"></div>
                </div>
                <div>
                    <div class="cf-pax-chart-title">Antal ordrer per segment</div>
                    <div class="cf-pax-bars" id="cfOrdChart"></div>
                </div>
            </div>
            <div class="cf-pax-legend">
                <div class="cf-pax-leg-item"><div class="cf-pax-leg-dot" style="background:#8e631f"></div>Festival</div>
                <div class="cf-pax-leg-item"><div class="cf-pax-leg-dot" style="background:#4a6e96"></div>150+ pax</div>
                <div class="cf-pax-leg-item"><div class="cf-pax-leg-dot" style="background:#7a9c54"></div>70–150 pax</div>
                <div class="cf-pax-leg-item"><div class="cf-pax-leg-dot" style="background:#e8a832"></div>20–70 pax</div>
                <div class="cf-pax-leg-item"><div class="cf-pax-leg-dot" style="background:#d7d1ca"></div>0–20 pax</div>
            </div>
        </div>

        <!-- Bottom grid: heatmap + payment -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
            <div class="cf-card">
                <div class="cf-card-title">Sæsonvarme — 2 år</div>
                <div class="cf-heatmap-grid" id="cfHeatmap"></div>
                <div class="cf-hm-scale" id="cfHmScale"></div>
            </div>
            <div class="cf-card">
                <div class="cf-card-title">Betalingsadfærd</div>
                <div style="font-size:11px;color:#8a8580;margin-bottom:12px;display:flex;gap:16px">
                    <span style="color:#7a9c54;font-weight:700">■ Til tiden</span>
                    <span style="color:#e8a832;font-weight:700">■ 1–14 dage for sent</span>
                    <span style="color:#bc3a3a;font-weight:700">■ 15+ dage for sent</span>
                </div>
                <div id="cfPayBars"></div>
                ${payData.customers.length === 0 ? '<div style="color:#8a8580;font-size:13px;padding:20px 0;text-align:center">Ingen data endnu — kræver matchede fakturaer</div>' : ''}
            </div>
        </div>
    `;

    // Render charts
    _cfDrawYTD(data);
    _cfRenderPax(data);
    _cfRenderHeatmap(data.heatmap);
    _cfRenderPayBars(payData.customers);

    // Resize handler
    if (_cfResizeHandler) window.removeEventListener('resize', _cfResizeHandler);
    _cfResizeHandler = () => _cfDrawYTD(data);
    window.addEventListener('resize', _cfResizeHandler);

    // Sandwich toggle
    el.querySelector('#cfYtdKr').onclick = function() {
        el.querySelector('#cfYtdSandwich').classList.remove('active');
        this.classList.add('active');
        _cfDrawYTD(data);
    };
    el.querySelector('#cfYtdSandwich').onclick = function() {
        el.querySelector('#cfYtdKr').classList.remove('active');
        this.classList.add('active');
        _cfDrawYTD(data, true);
    };
}

/* ── YTD Canvas ── */
function _cfDrawYTD(data, sandwich) {
    const canvas = document.getElementById('cfYtdCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const dpr = window.devicePixelRatio || 1;
    const W = canvas.parentElement.getBoundingClientRect().width - 48;
    const H = 220;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.scale(dpr, dpr);

    const thisYear = new Date().getFullYear();
    const prevYear = thisYear - 1;
    const prev2Year = thisYear - 2;

    const rate = sandwich ? (data.sandwich_rate || 45) : 1;
    const unit = sandwich ? '🥪' : 'M';

    const allVals = [
        ...(data.ytd[thisYear] || []),
        ...(data.ytd[prevYear] || []),
        ...(data.ytd[prev2Year] || [])
    ].filter(v => v != null).map(v => v / rate);

    const max = Math.ceil(Math.max(1, ...allVals) / 100) * 100;

    const pL = 60, pR = 20, pT = 10, pB = 30;
    const pW = W - pL - pR, pH = H - pT - pB;
    const tx = i => pL + (i / 11) * pW;
    const ty = v => pT + pH - (v / max) * pH;

    // Grid
    ctx.strokeStyle = '#e8e4de'; ctx.lineWidth = 1;
    const gridStep = max > 500 ? 200 : max > 200 ? 100 : 50;
    for (let v = 0; v <= max; v += gridStep) {
        const y = ty(v);
        ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(pL + pW, y); ctx.stroke();
        ctx.fillStyle = '#8a8580'; ctx.font = '10px system-ui'; ctx.textAlign = 'right';
        if (sandwich) {
            ctx.fillText(Math.round(v) + 'k', pL - 6, y + 3);
        } else {
            ctx.fillText((v / 1000).toFixed(v >= 1000 ? 0 : 1) + unit, pL - 6, y + 3);
        }
    }

    // Month labels
    ctx.fillStyle = '#8a8580'; ctx.font = '10px system-ui'; ctx.textAlign = 'center';
    _CF_MONTHS.forEach((m, i) => ctx.fillText(m, tx(i), H - pB + 16));

    // Line drawing helper
    function drawLine(yearData, color, dashed, alpha) {
        if (!yearData) return;
        const pts = yearData.map((v, i) => v != null ? { x: tx(i), y: ty(v / rate) } : null).filter(Boolean);
        if (pts.length < 2) return;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = dashed ? 2 : 3;
        ctx.setLineDash(dashed ? [6, 4] : []);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
        ctx.stroke();

        if (!dashed && pts.length > 0) {
            const l = pts[pts.length - 1];
            ctx.fillStyle = color;
            ctx.beginPath(); ctx.arc(l.x, l.y, 5, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = 'white';
            ctx.beginPath(); ctx.arc(l.x, l.y, 2.5, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
    }

    // Area fill under current year
    const curData = data.ytd[thisYear];
    if (curData) {
        const pts = curData.map((v, i) => v != null ? { x: tx(i), y: ty(v / rate) } : null).filter(Boolean);
        if (pts.length > 1) {
            ctx.save();
            ctx.beginPath();
            pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
            ctx.lineTo(pts[pts.length - 1].x, ty(0));
            ctx.lineTo(pts[0].x, ty(0));
            ctx.closePath();
            const g = ctx.createLinearGradient(0, pT, 0, pT + pH);
            g.addColorStop(0, 'rgba(142,99,31,0.15)');
            g.addColorStop(1, 'rgba(142,99,31,0.01)');
            ctx.fillStyle = g;
            ctx.fill();
            ctx.restore();
        }
    }

    if (_cfYtdRefs.prevprev) drawLine(data.ytd[prev2Year], '#8a8580', true, 0.7);
    if (_cfYtdRefs.prev) drawLine(data.ytd[prevYear], '#4a6e96', true, 0.85);
    if (_cfYtdRefs.cur) drawLine(data.ytd[thisYear], '#8e631f', false, 1);

    // Today marker
    const todayMonth = new Date().getMonth();
    const todayDay = new Date().getDate();
    const todayX = tx(todayMonth) + (todayDay / 30) * (pW / 11);
    ctx.save();
    ctx.strokeStyle = '#d7d1ca'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(todayX, pT); ctx.lineTo(todayX, pT + pH); ctx.stroke();
    ctx.fillStyle = '#8a8580'; ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('I DAG', todayX, pT + 8);
    ctx.restore();
}

function _cfToggleYtdRef(key) {
    _cfYtdRefs[key] = !_cfYtdRefs[key];
    const map = { cur: 'cfLegCur', prev: 'cfLegPrev', prevprev: 'cfLegPrev2' };
    const el = document.getElementById(map[key]);
    if (el) el.classList.toggle('dimmed', !_cfYtdRefs[key]);
    if (_cfAnalyseData) _cfDrawYTD(_cfAnalyseData);
}

/* ── PAX Segments ── */
function _cfRenderPax(data) {
    if (!data || !data.pax) return;
    const months = data.pax.months;
    const monthsRef = data.pax.monthsRef;

    // For now, only monthly data from API
    let showRev, showOrd, showRef, showLabels;

    if (_cfPaxView === 'enkelt') {
        _cfCurIdx = Math.max(0, Math.min(_cfCurIdx, months.length - 1));
        showRev = [months[_cfCurIdx].rev];
        showOrd = [months[_cfCurIdx].ord];
        showRef = [monthsRef[_cfCurIdx]?.rev || { sm: 0, md: 0, lg: 0, xl: 0, festival: 0 }];
        showLabels = [months[_cfCurIdx].label];

        const nav = document.getElementById('cfPeriodNav');
        const refTg = document.getElementById('cfRefToggle');
        if (nav) nav.style.display = 'flex';
        if (refTg) refTg.style.display = 'flex';

        const navLabel = document.getElementById('cfNavLabel');
        if (navLabel) navLabel.textContent = months[_cfCurIdx].label;
    } else {
        const win = _CF_PAX_WIN.maaned;
        const start = Math.max(0, months.length - win);
        showRev = months.slice(start).map(m => m.rev);
        showOrd = months.slice(start).map(m => m.ord);
        showRef = monthsRef.slice(start).map(m => m?.rev || { sm: 0, md: 0, lg: 0, xl: 0, festival: 0 });
        showLabels = months.slice(start).map(m => m.label);

        const nav = document.getElementById('cfPeriodNav');
        const refTg = document.getElementById('cfRefToggle');
        if (nav) nav.style.display = 'none';
        if (refTg) refTg.style.display = 'none';
    }

    const maxRev = Math.max(1, ...showRev.map(r => _CF_SEGS.reduce((s, k) => s + (r[k] || 0), 0)));
    const maxOrd = Math.max(1, ...showOrd.map(r => _CF_SEGS.reduce((s, k) => s + (r[k] || 0), 0)));

    _cfBuildPaxChart('cfRevChart', showRev, showLabels, showRef, maxRev);
    _cfBuildPaxChart('cfOrdChart', showOrd, showLabels, monthsRef.slice(months.length - showOrd.length).map(m => m?.ord || { sm: 0, md: 0, lg: 0, xl: 0, festival: 0 }), maxOrd);
}

function _cfBuildPaxChart(containerId, data, labels, refArr, maxVal) {
    const c = document.getElementById(containerId);
    if (!c) return;
    c.innerHTML = '';

    data.forEach((d, i) => {
        const grp = document.createElement('div');
        grp.className = 'cf-pax-bar-group';

        // Stacked segments (bottom to top: sm, md, lg, xl, festival)
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative;z-index:2;width:100%;display:flex;flex-direction:column;justify-content:flex-end;height:192px;';

        [..._CF_SEGS].reverse().forEach(k => {
            const val = d[k] || 0;
            if (val <= 0) return;
            const seg = document.createElement('div');
            seg.className = 'cf-pax-seg';
            seg.style.height = Math.max(3, (val / maxVal) * 180) + 'px';
            seg.style.background = _CF_SEG_COLORS[k];
            wrap.appendChild(seg);
        });

        const lbl = document.createElement('div');
        lbl.className = 'cf-pax-lbl';
        lbl.textContent = labels[i];

        grp.appendChild(wrap);
        grp.appendChild(lbl);
        c.appendChild(grp);
    });
}

function _cfSetPaxPeriod(p) {
    _cfPaxPeriod = p;
    document.querySelectorAll('#cfPaxPeriodTg .cf-toggle-btn').forEach(b => {
        b.classList.toggle('active', b.textContent.toLowerCase().includes(p === 'maaned' ? 'måned' : p));
    });
    if (_cfAnalyseData) _cfRenderPax(_cfAnalyseData);
}

function _cfSetPaxView(v) {
    _cfPaxView = v;
    document.querySelectorAll('#cfPaxViewTg .cf-toggle-btn').forEach(b => {
        b.classList.toggle('active', b.textContent.toLowerCase() === v);
    });
    if (v === 'enkelt' && _cfAnalyseData) _cfCurIdx = _cfAnalyseData.pax.months.length - 1;
    if (_cfAnalyseData) _cfRenderPax(_cfAnalyseData);
}

function _cfSetPaxUnit(u) {
    _cfPaxUnit = u;
    document.querySelectorAll('#cfPaxUnitTg .cf-toggle-btn').forEach(b => {
        b.classList.toggle('active', b.textContent === u);
    });
    if (_cfAnalyseData) _cfRenderPax(_cfAnalyseData);
}

function _cfNavPeriod(d) {
    if (!_cfAnalyseData) return;
    _cfCurIdx = Math.max(0, Math.min(_cfCurIdx + d, _cfAnalyseData.pax.months.length - 1));
    _cfRenderPax(_cfAnalyseData);
}

function _cfToggleRef() {
    _cfRefOn = !_cfRefOn;
    const el = document.getElementById('cfRefToggle');
    if (el) el.classList.toggle('on', _cfRefOn);
    if (_cfAnalyseData) _cfRenderPax(_cfAnalyseData);
}

/* ── Heatmap ── */
function _cfRenderHeatmap(heatmap) {
    const grid = document.getElementById('cfHeatmap');
    if (!grid || !heatmap) return;
    grid.innerHTML = '';

    const thisYear = new Date().getFullYear();
    const years = [thisYear, thisYear - 1];

    // Color function
    function hc(v) {
        if (v == null) return '#f0ede8';
        if (v < 40) return '#e8f0f6';
        if (v < 55) return '#b8d4e8';
        if (v < 70) return '#f1e6b2';
        if (v < 82) return '#e8a832';
        if (v < 92) return '#a67c3d';
        return '#6b4a16';
    }
    function htc(v) { return v == null ? '#c0bab4' : v > 65 ? 'white' : '#2c2416'; }

    // Header row
    const corner = document.createElement('div');
    grid.appendChild(corner);
    _CF_MONTHS.forEach(m => {
        const el = document.createElement('div');
        el.style.cssText = 'font-size:10px;font-weight:700;color:#8a8580;text-align:center';
        el.textContent = m;
        grid.appendChild(el);
    });

    // Data rows
    years.forEach(yr => {
        const vals = heatmap[yr] || new Array(12).fill(null);
        const label = document.createElement('div');
        label.className = 'cf-hm-label';
        label.textContent = yr;
        grid.appendChild(label);

        _CF_MONTHS.forEach((m, i) => {
            const v = vals[i];
            const cell = document.createElement('div');
            cell.className = 'cf-hm-cell';
            cell.style.background = hc(v);
            cell.style.color = htc(v);
            cell.textContent = v != null ? v : '';
            grid.appendChild(cell);
        });
    });

    // Scale
    const scale = document.getElementById('cfHmScale');
    if (scale) {
        scale.innerHTML = '<span style="font-size:11px;color:#8a8580;margin-right:4px">Lav</span>';
        [20, 40, 55, 70, 82, 92, 100].forEach(v => {
            const d = document.createElement('div');
            d.className = 'cf-hm-scale-cell';
            d.style.background = hc(v);
            d.style.display = 'inline-block';
            scale.appendChild(d);
        });
        const high = document.createElement('span');
        high.style.cssText = 'font-size:11px;color:#8a8580;margin-left:4px';
        high.textContent = 'Høj';
        scale.appendChild(high);
    }
}

/* ── Payment Behavior ── */
function _cfRenderPayBars(customers) {
    const c = document.getElementById('cfPayBars');
    if (!c || !customers.length) return;

    const mx = Math.max(1, ...customers.map(p => Math.abs(p.avg_days))) + 5;

    customers.forEach(p => {
        const row = document.createElement('div');
        row.className = 'cf-pay-row';

        const nm = document.createElement('div');
        nm.className = 'cf-pay-name';
        nm.textContent = p.name;
        nm.title = p.name;

        const track = document.createElement('div');
        track.className = 'cf-pay-track';

        const bar = document.createElement('div');
        bar.className = 'cf-pay-bar ' + p.color;
        const pct = Math.min(100, (Math.abs(p.avg_days) / mx) * 100);
        bar.style.width = Math.max(15, pct) + '%';
        if (pct > 20) bar.textContent = Math.abs(Math.round(p.avg_days)) + 'd';
        track.appendChild(bar);

        const badge = document.createElement('div');
        badge.className = 'cf-pay-badge ' + p.color;
        badge.textContent = p.avg_days <= 0
            ? `${Math.abs(Math.round(p.avg_days))}d tidligt`
            : `+${Math.round(p.avg_days)}d`;

        row.appendChild(nm);
        row.appendChild(track);
        row.appendChild(badge);
        c.appendChild(row);
    });
}
