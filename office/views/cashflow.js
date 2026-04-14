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
    return `${day}. ${mon}`;
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

async function initCashflow(container) {
    _cfEl = container;
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
        const [stats, weekly, invoices, upcoming, unmatched] = await Promise.all([
            fetchCfStats(),
            fetchCfWeekly(),
            fetchCfInvoices(_cfInvTab),
            fetchCfUpcoming(),
            fetchCfTransactions({ unmatched: true, limit: 5 })
        ]);

        _cfBuildOverblik(content, stats, weekly, invoices, upcoming, unmatched);
    } catch (err) {
        content.innerHTML = `<div class="cf-empty"><div class="cf-empty-icon">⚠️</div>${err.message}</div>`;
    }
}

function _cfBuildOverblik(el, stats, weekly, invoices, upcoming, unmatched) {
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
                <button class="cf-upload-btn" id="cfUploadBtn">↑ Upload CSV</button>
                <input type="file" id="cfCsvInput" accept=".csv" style="display:none">
            </div>
        </div>

        <!-- Metrics -->
        <div class="cf-metrics">
            <div class="cf-metric positive">
                <div class="cf-metric-label">Bankindestående (est.)</div>
                <div class="cf-metric-value ${stats.saldo != null ? 'green' : ''}">${stats.saldo != null ? _cfFmt(stats.saldo) : '—'}</div>
                <div class="cf-metric-sub">Baseret på uploaded CSV</div>
            </div>
            <div class="cf-metric warning">
                <div class="cf-metric-label">Udestående fakturaer</div>
                <div class="cf-metric-value">${_cfFmt(stats.outstanding_total)}</div>
                <div class="cf-metric-sub">${stats.outstanding_count} fakturaer</div>
            </div>
            <div class="cf-metric alert">
                <div class="cf-metric-label">Forfaldne (ikke betalt)</div>
                <div class="cf-metric-value ${stats.overdue_count > 0 ? 'red' : ''}">${_cfFmt(stats.overdue_total)}</div>
                <div class="cf-metric-sub">${stats.overdue_count} fakturaer overdue</div>
            </div>
            <div class="cf-metric neutral">
                <div class="cf-metric-label">Forventet ind — 30 dage</div>
                <div class="cf-metric-value">${_cfFmt(stats.expected_30d_total)}</div>
                <div class="cf-metric-sub">Baseret på forfaldsdatoer</div>
            </div>
        </div>

        <!-- Main grid -->
        <div class="cf-main-grid">
            <div>
                <!-- Weekly chart -->
                <div class="cf-card">
                    <div class="cf-card-title">
                        Pengestrøm — næste 8 uger
                        <span style="font-weight:400;font-size:11px">Estimat baseret på forfaldsdatoer</span>
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
                        <button class="cf-inv-tab ${_cfInvTab === 'alle' ? 'active' : ''}" data-tab="alle">Alle</button>
                        <button class="cf-inv-tab ${_cfInvTab === 'udestaaende' ? 'active' : ''}" data-tab="udestaaende">Udestående</button>
                        <button class="cf-inv-tab ${_cfInvTab === 'forfaldne' ? 'active' : ''}" data-tab="forfaldne">Forfaldne</button>
                        <button class="cf-inv-tab ${_cfInvTab === 'sandsynlig' ? 'active' : ''}" data-tab="sandsynlig">Sandsynlig betalt</button>
                        <button class="cf-inv-tab ${_cfInvTab === 'betalt' ? 'active' : ''}" data-tab="betalt">Betalt</button>
                    </div>
                    <div style="padding:8px 16px;display:flex;justify-content:flex-end">
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
                    <div class="cf-unmatched-header">⚠️ ${unmatched.rows.length} posteringer kan ikke matches</div>
                    ${unmatched.rows.map(tx => `
                        <div class="cf-unmatched-row" data-tx-id="${tx.id}">
                            <div>
                                <div style="font-weight:700">${tx.tekst.substring(0, 30)}</div>
                                <span style="font-size:11px;color:#8a8580">${_cfFmtDate(tx.dato)}</span>
                            </div>
                            <div style="font-weight:700;color:${tx.beloeb < 0 ? '#bc3a3a' : '#e8a832'}">${_cfFmt(tx.beloeb)}</div>
                        </div>
                    `).join('')}
                </div>` : ''}

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

    // Invoice rows
    _cfBuildInvoiceRows(invoices.rows);

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

    // Invoice tab switching
    el.querySelectorAll('#cfInvFilters .cf-inv-tab').forEach(btn => {
        btn.onclick = async () => {
            el.querySelectorAll('#cfInvFilters .cf-inv-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _cfInvTab = btn.dataset.tab;
            try {
                const inv = await fetchCfInvoices(_cfInvTab);
                _cfBuildInvoiceRows(inv.rows);
            } catch (err) { /* ignore */ }
        };
    });

    // Add invoice button
    el.querySelector('#cfAddInvBtn').onclick = () => _cfShowInvForm(el);
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

/* ── Invoice rows ── */
function _cfBuildInvoiceRows(rows) {
    const container = document.getElementById('cfInvRows');
    if (!container) return;

    if (rows.length === 0) {
        container.innerHTML = '<div style="padding:20px;text-align:center;color:#8a8580;font-size:13px">Ingen fakturaer i denne kategori</div>';
        return;
    }

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

        return `
        <div class="cf-inv-row" data-inv-id="${inv.id}">
            <div class="cf-inv-num">#${inv.id}</div>
            <div class="cf-inv-customer">${inv.kunde}${inv.betalingstype ? `<span>${inv.betalingstype}</span>` : ''}</div>
            <div class="cf-inv-amount">${_cfFmt(inv.beloeb)}</div>
            <div class="cf-inv-due ${dueClass}">${_cfFmtDate(inv.forfald)}</div>
            <div><span class="cf-pill ${pillClass}">${pillText}</span></div>
        </div>`;
    }).join('');

    // Click row → edit
    container.querySelectorAll('.cf-inv-row').forEach(row => {
        row.onclick = () => _cfShowInvForm(_cfEl, row.dataset.invId);
    });
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
                Kumulativ omsætning — YTD
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
            <div class="cf-card-title">Pax-segmenter — omsætning & ordrer</div>
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
                    <div class="cf-pax-chart-title">Omsætning per segment</div>
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
