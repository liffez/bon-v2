/**
 * office/views/crm-inbox.js
 * ════════════════════════════════════════════════════════════
 * CRM Indbakke — ufordelte mails fra mail_unmatched
 * ════════════════════════════════════════════════════════════
 */

let _inbContainer = null;
let _inbOpts = {};
let _inbActive = false;
let _inbMails = [];
let _inbSelected = null;
let _inbMailbox = '';        // '' = alle, 'bon' = bon@, 'kontakt' = kontakt@
let _inbFromDate = '';
let _inbBulkMode = false;
let _inbBulkSelected = new Set();
let _inbComposing = false;    // true mens svar-komposeren er åben (beskytter mod reload-clobber)

// ── Samlet indbakke (mail_threads) ──
// _inbView = aktivt filter-chip. Livscyklus: aabne|udsat|kunde|luk|alle.
// 'ufordelt' = den gamle triage-visning (bounces + ukendt) — uændret maskineri.
let _inbView = 'aabne';
let _inbQ = '';               // søgetekst (tråd-mode)
let _inbThreads = [];
let _inbThreadSel = null;     // åben tråd { thread, messages }
let _inbCounts = { aabne: 0, udsat: 0, kunde: 0, luk: 0, alle: 0, ufordelt: 0 };

const _INB_LIFECYCLE = ['aabne', 'udsat', 'kunde', 'luk', 'alle'];
function _inbIsThreadMode() { return _inbView !== 'ufordelt'; }

function initCrmInbox(containerEl, opts) {
    _inbContainer = containerEl;
    _inbOpts = opts || {};
    _inbActive = true;
    _inbRenderShell();
    _inbLoadCounts();
    _inbLoad();
}

function cleanupCrmInbox() {
    _inbActive = false;
    _inbContainer = null;
    _inbMails = [];
    _inbSelected = null;
    _inbMailbox = '';
    _inbFromDate = '';
    _inbBulkMode = false;
    _inbBulkSelected = new Set();
    _inbComposing = false;
    _inbView = 'aabne';
    _inbQ = '';
    _inbThreads = [];
    _inbThreadSel = null;
}

// Dispatcher: tråd-mode (livscyklus) vs. ufordelt-mode (legacy triage)
function _inbLoad() {
    if (_inbIsThreadMode()) _inbLoadThreads();
    else _inbLoadData();
}

function _inbRenderShell() {
    const topTitle = document.getElementById('office-topbar-title');
    if (topTitle) topTitle.textContent = 'Mail Indbakke';

    _inbContainer.innerHTML = `
        <style>
            .inb-layout { display: grid; grid-template-columns: 380px 1fr; gap: 12px; height: 100%; }
            @media (max-width: 800px) { .inb-layout { grid-template-columns: 1fr; } }

            .inb-list-panel {
                background: var(--color-surface, #fff); border-radius: 10px;
                box-shadow: 0 1px 4px rgba(0,0,0,0.07); overflow-y: auto;
            }
            .inb-list-header {
                padding: 14px 16px; border-bottom: 1px solid var(--color-border, #eee);
                font-size: 11px; font-weight: 700; text-transform: uppercase;
                letter-spacing: .5px; color: var(--color-text-dim, #888);
                display: flex; justify-content: space-between; align-items: center;
            }
            .inb-count {
                background: var(--brand-primary); color: white;
                padding: 2px 9px; border-radius: 10px; font-size: 11px; font-weight: 700;
            }
            .inb-mail-row {
                padding: 12px 16px; border-bottom: 1px solid var(--color-border, #eee);
                cursor: pointer; transition: background .1s;
                outline: none;
            }
            .inb-mail-row:hover { background: var(--color-background, #f5f4f2); }
            .inb-mail-row.selected { background: var(--brand-primary-light, #f1e6b2); }
            .inb-mail-row:focus { box-shadow: inset 0 0 0 2px var(--brand-primary, #8e631f); }
            .inb-mail-from { font-size: 14px; font-weight: 600; }
            .inb-mail-subject { font-size: 13px; color: var(--color-text, #333); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .inb-mail-meta { font-size: 11px; color: var(--color-text-dim, #aaa); margin-top: 4px; display: flex; justify-content: space-between; }
            .inb-mail-parsed { font-size: 11px; color: var(--brand-primary); margin-top: 2px; font-weight: 600; }
            .inb-mail-att { color: var(--brand-primary, #8e631f); font-weight: 600; margin-left: 6px; }

            /* ── Tråd-svar (allerede routet, vist for synlighed) ──── */
            .inb-mail-row.is-thread { border-left: 3px solid #5a8a5a; }
            .inb-entity-chip {
                display: inline-block; font-size: 10px; font-weight: 700;
                color: #3c6b3c; background: #e8f2e8; padding: 1px 7px;
                border-radius: 4px; margin-bottom: 4px; max-width: 100%;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            }
            .inb-thread-banner {
                font-size: 12px; color: #3c6b3c; background: #e8f2e8;
                padding: 8px 12px; border-radius: 6px; margin-bottom: 12px;
            }

            .inb-preview-panel {
                background: var(--color-surface, #fff); border-radius: 10px;
                box-shadow: 0 1px 4px rgba(0,0,0,0.07); padding: 24px; overflow-y: auto;
            }
            .inb-preview-header { margin-bottom: 16px; }
            .inb-preview-from {
                font-family: var(--font-heading, 'Playfair Display', Georgia, serif);
                font-size: 17px; font-weight: 700;
            }
            .inb-preview-subject { font-size: 15px; margin-top: 6px; font-weight: 500; }
            .inb-preview-date { font-size: 12px; color: var(--color-text-dim); margin-top: 6px; }
            .inb-preview-body {
                white-space: pre-wrap; font-size: 14px; line-height: 1.7;
                padding: 16px 0; border-top: 1px solid var(--color-border);
                border-bottom: 1px solid var(--color-border);
                max-height: 400px; overflow-y: auto;
            }
            /* HTML-mails sizer/kollapser selv (MailThread) — drop tekst-cap + pre-wrap */
            .inb-preview-body:has(.mt-html) { white-space: normal; max-height: none; overflow: visible; }
            .inb-refetch-bar {
                display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
                margin: 12px 0; padding: 10px 12px; font-size: 13px;
                background: var(--brand-primary-light, #f1e6b2);
                border: 1px solid var(--color-border); border-radius: 8px;
            }
            .inb-actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
            .inb-action-btn {
                padding: 8px 18px; border-radius: 8px; border: 1px solid var(--color-border, #ddd);
                background: var(--color-surface); font-size: 13px; cursor: pointer; font-weight: 600;
                font-family: inherit; transition: background .1s;
            }
            .inb-action-btn:hover { background: var(--brand-primary-light); }
            .inb-action-btn.danger { color: #c94040; }
            .inb-action-btn.danger:hover { background: var(--color-sentiment-neg-bg); }
            .inb-action-btn.primary { background: var(--brand-primary); color: white; border-color: transparent; }
            .inb-action-btn.primary:hover { filter: brightness(1.1); }

            .inb-link-form { margin-top: 12px; padding: 14px; background: var(--color-background, #f5f4f2); border-radius: 10px; border: 1px solid var(--color-border); }
            .inb-link-input {
                width: 100%; padding: 8px 12px; border-radius: 6px;
                border: 1px solid var(--color-border); font-size: 13px; margin-top: 6px;
                font-family: inherit;
            }
            .inb-link-input:focus { border-color: var(--brand-primary); outline: none; }
            .inb-link-submit { margin-top: 8px; }

            .inb-empty { text-align: center; padding: 40px; color: var(--color-text-dim); font-size: 14px; }
            .inb-hint { font-size: 11px; color: var(--color-text-dim); padding: 8px 16px; text-align: center; }
            .inb-filter-btn { font-size: 12px; padding: 4px 12px; border: 1.5px solid var(--color-border, #d7d1ca); border-radius: 14px; background: var(--color-surface, #fff); cursor: pointer; color: var(--color-text-dim); font-family: inherit; }
            .inb-filter-btn:hover { border-color: var(--brand-primary); }
            .inb-filter-btn.active { background: var(--brand-primary, #8e631f); color: #fff; border-color: var(--brand-primary); }

            /* ── Bulk-mode ──────────────────────────────────────── */
            .inb-mail-row.bulk-mode { display: flex; align-items: flex-start; gap: 10px; }
            .inb-mail-row.bulk-mode .inb-mail-check { padding-top: 2px; flex-shrink: 0; }
            .inb-mail-row.bulk-mode .inb-mail-check input { width: 18px; height: 18px; cursor: pointer; }
            .inb-mail-row.bulk-mode .inb-mail-body { flex: 1; min-width: 0; }
            .inb-mail-row.bulk-checked { background: #fff4d4; }
            .inb-mail-row.bulk-checked:hover { background: #ffeebb; }

            /* ── Bounce-styling ───────────────────────────────────── */
            .inb-mail-row.is-bounce {
                border-left: 3px solid #c94040;
            }
            .inb-bounce-badge {
                display: inline-block;
                background: #c94040;
                color: white;
                font-size: 9px;
                font-weight: 800;
                padding: 1px 6px;
                border-radius: 4px;
                letter-spacing: 0.5px;
                margin-right: 6px;
                vertical-align: middle;
            }
            .inb-mail-bounce-target {
                font-size: 11px;
                color: #c94040;
                margin-top: 4px;
                font-weight: 500;
            }
            .inb-mail-bounce-target code, .inb-mail-bounce-target strong {
                color: var(--color-text, #333);
            }
            .inb-bounce-panel {
                margin: 12px 0 16px;
                padding: 16px 18px;
                background: #fbe9e9;
                border-left: 4px solid #c94040;
                border-radius: 6px;
            }
            .inb-bounce-title {
                font-size: 14px;
                font-weight: 800;
                color: #c94040;
                margin-bottom: 8px;
            }
            .inb-bounce-recipient {
                font-size: 13px;
                color: #4a3210;
                margin-bottom: 10px;
            }
            .inb-bounce-recipient code {
                background: rgba(0,0,0,0.06);
                padding: 1px 6px;
                border-radius: 3px;
                font-family: 'Menlo', monospace;
                font-size: 12px;
            }
            .inb-bounce-customer {
                font-size: 14px;
                padding: 10px 0;
                color: var(--color-text, #333);
            }
            .inb-bounce-customer.inb-bounce-no-match {
                color: #8a8580;
                font-style: italic;
                font-size: 13px;
            }
            .inb-bounce-tel {
                color: var(--brand-primary, #8e631f);
                text-decoration: none;
                font-weight: 700;
            }
            .inb-bounce-tel:hover {
                text-decoration: underline;
            }
            .inb-bounce-no-phone {
                color: #aaa;
                font-style: italic;
                font-size: 13px;
            }
            .inb-bounce-actions {
                display: flex;
                gap: 8px;
                margin-top: 8px;
                flex-wrap: wrap;
            }

            /* ── Chip-bar + tråd-mode ────────────────────────────── */
            .inb-chips { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-bottom:12px; padding:0 4px; }
            .inb-chip { border:1px solid var(--color-border,#d7d1ca); background:#fff; border-radius:99px; padding:6px 13px; font-size:12.5px; font-weight:700; color:#6b6258; cursor:pointer; font-family:inherit; display:inline-flex; align-items:center; gap:6px; }
            .inb-chip:hover { border-color: var(--brand-primary); }
            .inb-chip.on { background: var(--brand-primary,#8e631f); color:#fff; border-color: var(--brand-primary,#8e631f); }
            .inb-chip .cnt { background: rgba(0,0,0,.12); border-radius:99px; padding:0 6px; font-size:11px; }
            .inb-chip.on .cnt { background: rgba(255,255,255,.25); }
            .inb-chip.src { font-weight:400; }
            .inb-chip.src.on { background: var(--brand-primary); border-color: var(--brand-primary); color:#fff; }
            .inb-chip.ufordelt.on { background:#9a6a10; border-color:#9a6a10; color:#fff; }
            .inb-sep { width:1px; height:22px; background: var(--color-border); margin:0 4px; }
            .inb-search2 { border:1px solid var(--color-border); border-radius:99px; padding:6px 12px; font-size:13px; width:210px; font-family:inherit; }

            .inb-th-row { padding:12px 16px; border-bottom:1px solid var(--color-border,#eee); cursor:pointer; border-left:3px solid transparent; }
            .inb-th-row:hover { background: var(--color-background,#f5f4f2); }
            .inb-th-row.sel { background: var(--brand-primary-light,#f1e6b2); border-left-color: var(--brand-primary); }
            .inb-th-row.unread .inb-th-from { font-weight:900; }
            .inb-th-top { display:flex; align-items:center; gap:8px; }
            .inb-dot2 { width:8px; height:8px; border-radius:50%; background:transparent; flex-shrink:0; }
            .inb-th-row.unread .inb-dot2 { background:#e8a832; }
            .inb-th-from { font-size:14px; font-weight:700; color: var(--color-ink,#2c2620); flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .inb-th-time { font-size:11px; color: var(--color-text-dim,#999); flex-shrink:0; }
            .inb-th-subj { font-size:13px; color:#5a544c; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:3px; }
            .inb-th-sent { font-size:11px; color:#5a7a36; margin-top:3px; }
            .inb-th-meta { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:6px; }
            .inb-tag2 { font-size:10px; font-weight:700; padding:1px 7px; border-radius:99px; }
            .inb-tag2.bon { background:#e8f0f6; color:#3d5e80; }
            .inb-tag2.kontakt { background:#f7f2d9; color:#8a6a1a; }
            .inb-tag2.lnk { background: var(--color-background,#f5f4f2); color:#6b6258; }
            .inb-tag2.warn { background:#fef3d6; color:#9a6a10; }
            .inb-ent-meta { font-size:10px; font-weight:600; color:#8a8178; }
            .inb-st { font-size:10px; font-weight:900; padding:1px 8px; border-radius:99px; text-transform:uppercase; }
            .inb-st.aaben { background:#fef3d6; color:#9a6a10; }
            .inb-st.afventer_kunde { background:#e8f0f6; color:#3d5e80; }
            .inb-st.afsluttet { background:#e8f2dc; color:#5a7a36; }
            .inb-snz { font-size:10px; font-weight:700; padding:1px 7px; border-radius:99px; background:#f3e8f7; color:#7a3d96; }

            .inb-rd-actions { display:flex; gap:8px; flex-wrap:wrap; margin:12px 0; position:relative; }
            .inb-snooze-menu { position:absolute; top:42px; left:0; background:#fff; border:1px solid var(--color-border); border-radius:10px; box-shadow:0 8px 28px rgba(0,0,0,.16); padding:6px; z-index:9; }
            .inb-snooze-menu button { display:block; width:100%; text-align:left; border:none; background:none; padding:9px 14px; font-size:13.5px; font-family:inherit; border-radius:8px; cursor:pointer; }
            .inb-snooze-menu button:hover { background:#f3e8f7; }
            .inb-composer { margin-top:14px; }
            .inb-composer textarea { width:100%; border:1px solid var(--color-border); border-radius:10px; padding:10px; font-family:inherit; font-size:13.5px; min-height:90px; resize:vertical; }
            .inb-composer .crow { display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap; }
            .inb-toggle { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--color-text-dim); cursor:pointer; }
        </style>

        <div class="inb-chips" id="inbChips"></div>

        <div id="inbBulkBar" style="display:${_inbBulkMode ? 'flex' : 'none'};gap:8px;align-items:center;margin-bottom:10px;padding:8px 12px;background:#fff8e6;border:1px solid #e8d68a;border-radius:8px;flex-wrap:wrap">
            <span style="font-size:13px;font-weight:600" id="inbBulkCount">0 valgt</span>
            <button class="inb-filter-btn" onclick="_inbBulkSelectAll()">Vælg alle synlige</button>
            <button class="inb-filter-btn" onclick="_inbBulkClear()">Fravælg alle</button>
            <button class="inb-action-btn danger" onclick="_inbBulkIgnore()" id="inbBulkIgnoreBtn" style="margin-left:auto" disabled>Ignorer valgte</button>
        </div>
        <div class="inb-layout">
            <div class="inb-list-panel">
                <div class="inb-list-header">
                    <span id="inbListHead">Åbne — kræver handling</span>
                    <span class="inb-count" id="inbCount">0</span>
                </div>
                <div id="inbList"></div>
            </div>
            <div class="inb-preview-panel" id="inbPreview">
                <div class="inb-empty">Vælg en tråd fra listen</div>
            </div>
        </div>
    `;
    _inbRenderChips();
}

// Chip-bar: livscyklus-filtre + Ufordelt + kilde + søg (tråd-mode)
function _inbRenderChips() {
    const el = document.getElementById('inbChips');
    if (!el) return;
    const c = _inbCounts;
    const chip = (view, label, count, extra) =>
        `<button class="inb-chip ${extra || ''} ${_inbView === view ? 'on' : ''}" onclick="_inbSetView('${view}')">${label}` +
        (count != null ? ` <span class="cnt">${count}</span>` : '') + `</button>`;
    let html = '';
    html += chip('aabne', 'Åbne', c.aabne);
    html += chip('udsat', '⏰ Udsat', c.udsat);
    html += chip('kunde', 'Afventer kunde', c.kunde);
    html += chip('luk', 'Afsluttet', c.luk);
    html += chip('alle', 'Alle', null);
    html += '<span class="inb-sep"></span>';
    html += chip('ufordelt', '⚠ Ufordelt', c.ufordelt, 'ufordelt');
    html += '<span class="inb-sep"></span>';
    html += `<button class="inb-chip src ${_inbMailbox === 'bon' ? 'on' : ''}" onclick="_inbSetMailbox('${_inbMailbox === 'bon' ? '' : 'bon'}')">bon@</button>`;
    html += `<button class="inb-chip src ${_inbMailbox === 'kontakt' ? 'on' : ''}" onclick="_inbSetMailbox('${_inbMailbox === 'kontakt' ? '' : 'kontakt'}')">kontakt@</button>`;
    if (_inbIsThreadMode()) {
        html += '<span style="flex:1"></span>';
        html += `<input class="inb-search2" id="inbSearch2" placeholder="🔍 Søg al mail (også afsluttet)…" value="${_inbEscapeAttr(_inbQ)}">`;
    } else {
        html += '<span style="flex:1"></span>';
        html += `<button class="inb-filter-btn ${_inbBulkMode ? 'active' : ''}" onclick="_inbToggleBulk()">${_inbBulkMode ? '✕ Afslut markering' : '✓ Vælg flere'}</button>`;
        html += `<input type="date" id="inbFromDate" value="${_inbFromDate}" onchange="_inbSetFromDate(this.value)" style="font-size:12px;padding:4px 8px;border:1px solid var(--color-border);border-radius:6px;margin-left:6px">`;
    }
    el.innerHTML = html;
    const s = document.getElementById('inbSearch2');
    if (s) {
        let deb = null;
        s.addEventListener('input', () => {
            clearTimeout(deb);
            deb = setTimeout(() => { _inbQ = s.value.trim(); _inbLoadThreads(); }, 300);
        });
    }
}

function _inbSetView(view) {
    _inbView = view;
    _inbThreadSel = null;
    _inbSelected = null;
    _inbBulkMode = false;
    _inbBulkSelected = new Set();
    _inbComposing = false;
    _inbRenderShell();
    const prev = document.getElementById('inbPreview');
    if (prev) prev.innerHTML = `<div class="inb-empty">${_inbIsThreadMode() ? 'Vælg en tråd fra listen' : 'Vælg en mail fra listen'}</div>`;
    _inbLoad();
}
window._inbSetView = _inbSetView;

async function _inbLoadCounts() {
    try {
        _inbCounts = await fetchMailThreadCounts();
        _inbRenderChips();
    } catch (e) { /* badge er kosmetisk */ }
}

/* ── TRÅD-MODE (livscyklus via /mail/threads) ───────────────── */

let _inbThreadEntity = null;   // entitet for åben tråd (til "Åbn →")

const _INB_HEAD = {
    aabne: 'Åbne — kræver handling', udsat: 'Udsatte (popper tilbage på datoen)',
    kunde: 'Afventer svar fra kunde', luk: 'Afsluttede (arkiv · søgbar)', alle: 'Alle tråde',
};

async function _inbLoadThreads() {
    if (!_inbActive) return;
    const head0 = document.getElementById('inbListHead');
    if (head0) head0.textContent = _INB_HEAD[_inbView] || 'Tråde';
    try {
        const params = { status: _inbView };
        if (_inbMailbox) params.mailbox = _inbMailbox;
        if (_inbQ) params.q = _inbQ;
        _inbThreads = await fetchMailThreads(params);
        _inbRenderThreadList();
        const head = document.getElementById('inbListHead');
        if (head) head.textContent = _inbQ ? ('Søgning · ' + _inbThreads.length + ' træffere') : (_INB_HEAD[_inbView] || 'Tråde');
        const cnt = document.getElementById('inbCount');
        if (cnt) cnt.textContent = _inbThreads.length;
        if (_inbComposing) return;
        if (_inbThreadSel && !_inbThreads.find(t => t.id === _inbThreadSel)) {
            _inbThreadSel = null;
            const prev = document.getElementById('inbPreview');
            if (prev) prev.innerHTML = '<div class="inb-empty">Vælg en tråd fra listen</div>';
        }
    } catch (err) {
        _inbShowLoadError(err, 'mailtråde');
    }
}

function _inbThreadTime(iso) {
    return (window.MailThread && MailThread.fmtDate) ? MailThread.fmtDate(iso) : _inbFmtReceivedAt(iso);
}

// Link-chip med tag-nummer: kunde → "🔗 Navn · #k-3857" (bon-label har allerede bonnummeret)
function _inbLinkChip(link) {
    if (!link) return '<span class="inb-tag2 warn">⚠ ikke knyttet</span>';
    var num = link.type === 'customer' ? ' · #k-' + link.id : '';
    return '<span class="inb-tag2 lnk">🔗 ' + _inbEscape(link.label || '') + num + '</span>';
}

// Standardiseret kontekst-linje for en tråd: firma + antal (bon) — vises ud over
// link-chippen (bon#) og afsendernavnet, så indbakken altid viser hvem + hvor meget.
function _inbEntityMeta(link) {
    if (!link) return '';
    var bits = [];
    if (link.company_name) bits.push(_inbEscape(link.company_name));
    if (link.type === 'bon') {
        if (link.units) bits.push(link.units + ' enh.');
        else if (link.pax) bits.push(link.pax + ' pax');
    }
    return bits.length ? '<span class="inb-ent-meta">' + bits.join(' · ') + '</span>' : '';
}

function _inbRenderThreadList() {
    const el = document.getElementById('inbList');
    if (!el) return;
    if (!_inbThreads.length) {
        el.innerHTML = '<div class="inb-empty">🎉 Intet her</div>';
        return;
    }
    const ST = { aaben:'Åben', afventer_kunde:'Afventer kunde', afsluttet:'Afsluttet' };
    el.innerHTML = _inbThreads.map(t => {
        const sent = (t.handling_status !== 'aaben' && t.last_outbound_at)
            ? `<div class="inb-th-sent">↗ Sendt ${_inbThreadTime(t.last_outbound_at)}${t.last_outbound_by ? ' · ' + _inbEscape(t.last_outbound_by) : ''}</div>` : '';
        const linkTag = _inbLinkChip(t.link);
        const snz = t.snoozed && t.snooze_until ? `<span class="inb-snz">⏰ ${_inbThreadTime(t.snooze_until)}</span>` : '';
        return `<div class="inb-th-row ${t.has_unread ? 'unread' : ''} ${_inbThreadSel === t.id ? 'sel' : ''}" data-id="${t.id}" onclick="_inbOpenThread(${t.id})">
            <div class="inb-th-top"><span class="inb-dot2"></span><span class="inb-th-from">${_inbEscape(t.from || '')}</span><span class="inb-th-time">${_inbThreadTime(t.time)}</span></div>
            <div class="inb-th-subj">${_inbEscape(t.subject || '')}</div>${sent}
            <div class="inb-th-meta">
                <span class="inb-tag2 ${t.src}">${t.src}@</span>
                ${linkTag}
                ${_inbEntityMeta(t.link)}
                <span class="inb-st ${t.handling_status}">${ST[t.handling_status] || ''}</span>
                ${snz}
            </div>
        </div>`;
    }).join('');
}

async function _inbOpenThread(id) {
    _inbThreadSel = id;
    _inbComposing = false;
    document.querySelectorAll('.inb-th-row').forEach(r => r.classList.toggle('sel', parseInt(r.dataset.id) === id));
    try {
        const data = await fetchMailThread(id);
        _inbRenderThreadReader(data);
        _inbLoadCounts();
        const row = document.querySelector('.inb-th-row[data-id="' + id + '"]');
        if (row) row.classList.remove('unread');
    } catch (err) {
        alert('Kunne ikke åbne tråd: ' + err.message);
    }
}
window._inbOpenThread = _inbOpenThread;

function _inbRenderThreadReader(data) {
    const el = document.getElementById('inbPreview');
    if (!el) return;
    const t = data.thread;
    _inbThreadEntity = t.link || null;
    const ST = { aaben:'Åben', afventer_kunde:'Afventer kunde', afsluttet:'Afsluttet' };
    const linkTag = _inbLinkChip(t.link);
    const snz = t.snoozed && t.snooze_until ? `<span class="inb-snz">⏰ rykker ${_inbThreadTime(t.snooze_until)}</span>` : '';
    const isBon = t.link && t.link.type === 'bon';
    const isCust = t.link && t.link.type === 'customer';
    el.innerHTML =
        `<div class="inb-preview-header">
            <div class="inb-preview-from">${_inbEscape(t.from || '')} &lt;${_inbEscape(t.email || '')}&gt;</div>
            <div class="inb-preview-subject">${_inbEscape(t.subject || '')}</div>
            <div class="inb-preview-date">
                <span class="inb-tag2 ${t.src}">${t.src}@</span>
                <span class="inb-st ${t.handling_status}">${ST[t.handling_status] || ''}</span>
                ${snz} ${linkTag} ${_inbEntityMeta(t.link)}
            </div>
        </div>
        <div class="inb-rd-actions">
            <button class="inb-action-btn primary" onclick="_inbThreadDone(${t.id})">✓ Afslut</button>
            <button class="inb-action-btn" onclick="_inbThreadSnoozeMenu(event)">⏰ Udsæt ▾</button>
            <div class="inb-snooze-menu" id="inbSnoozeMenu" style="display:none">
                <button onclick="_inbThreadSnooze(${t.id},1)">I morgen</button>
                <button onclick="_inbThreadSnooze(${t.id},3)">Om 3 dage</button>
                <button onclick="_inbThreadSnooze(${t.id},7)">Om 1 uge</button>
                <button onclick="_inbThreadSnooze(${t.id},30)">Om 1 måned</button>
            </div>
            ${isBon ? `<button class="inb-action-btn" onclick="_inbThreadOpenEntity()">Åbn bon →</button>`
                    : `<button class="inb-action-btn" onclick="_inbThreadCreateBon(${t.id})">📋 Opret bon fra mail</button>`}
            ${isCust ? `<button class="inb-action-btn" onclick="_inbThreadOpenEntity()">Åbn kunde →</button>` : ''}
        </div>
        <div id="inbThreadHost"></div>
        <div class="inb-composer">
            <textarea id="inbThreadReply" placeholder="Skriv svar…  (sendes via systemet → Afventer kunde)"></textarea>
            <div class="crow">
                <button class="inb-action-btn primary" id="inbThreadSendBtn" onclick="_inbThreadSend(${t.id})">✉ Send svar</button>
                <label class="inb-toggle"><input type="checkbox" id="inbThreadRemind" checked> Rykk mig om 3 dage hvis intet svar</label>
            </div>
        </div>`;
    const host = document.getElementById('inbThreadHost');
    if (host && window.MailThread && MailThread.renderHistory) {
        MailThread.renderHistory(host, {
            messages: (data.messages || []).map(m => ({ ...m, created_at: m.at, is_read: true })),
            maxHeight: 460,
        });
    } else if (host) {
        host.textContent = (data.messages || []).map(m => m.body_text).join('\n\n———\n\n');
    }
}

function _inbThreadSnoozeMenu(e) {
    if (e) e.stopPropagation();
    const m = document.getElementById('inbSnoozeMenu');
    if (m) m.style.display = m.style.display === 'none' ? 'block' : 'none';
}
window._inbThreadSnoozeMenu = _inbThreadSnoozeMenu;

async function _inbThreadSnooze(id, days) {
    try { await patchMailThread(id, { snooze_days: days }); await _inbAfterThreadMutate(id, 'Udsat → popper tilbage i Åbne'); }
    catch (e) { alert('Fejl: ' + e.message); }
}
window._inbThreadSnooze = _inbThreadSnooze;

async function _inbThreadDone(id) {
    try { await patchMailThread(id, { handling_status: 'afsluttet' }); await _inbAfterThreadMutate(id, 'Afsluttet → arkiv'); }
    catch (e) { alert('Fejl: ' + e.message); }
}
window._inbThreadDone = _inbThreadDone;

async function _inbThreadSend(id) {
    const ta = document.getElementById('inbThreadReply');
    const btn = document.getElementById('inbThreadSendBtn');
    const remind = document.getElementById('inbThreadRemind');
    const body = ta ? ta.value.trim() : '';
    if (!body) { alert('Skriv et svar først'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Sender…'; }
    try {
        await replyMailThread(id, { body, remind_days: (remind && remind.checked) ? 3 : 0 });
        await _inbAfterThreadMutate(id, 'Svar sendt → Afventer kunde');
    } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = '✉ Send svar'; }
        alert('Kunne ikke sende svar: ' + e.message);
    }
}
window._inbThreadSend = _inbThreadSend;

// Efter mutation: hvis tråden forlader det aktive filter → ryd preview + næste; ellers genåbn.
async function _inbAfterThreadMutate(id, msg) {
    _inbComposing = false;
    const menu = document.getElementById('inbSnoozeMenu');
    if (menu) menu.style.display = 'none';
    const leaves = (_inbView === 'aabne' || _inbView === 'kunde' || _inbView === 'udsat');
    if (leaves) {
        _inbThreadSel = null;
        const prev = document.getElementById('inbPreview');
        if (prev) prev.innerHTML = `<div class="inb-empty">✓ ${_inbEscape(msg)} — vælg næste</div>`;
        await _inbLoadThreads();
    } else {
        await _inbLoadThreads();
        await _inbOpenThread(id);
    }
    await _inbLoadCounts();
}

function _inbThreadCreateBon(id) {
    mailThreadCreateBon(id, {}).then(res => {
        const p = res.prefill || {};
        if (typeof window.openBonOpretModal === 'function') {
            window.openBonOpretModal({ customerId: p.customer_id, companyId: p.company_id, name: p.name, email: p.email, mailThreadId: id });
        } else {
            alert('Opret bon for: ' + (p.name || p.email || 'ukendt') + (p.company_name ? ' (' + p.company_name + ')' : '') +
                  '\n\n(Åbn bon-opret manuelt — prefill-hook ikke tilgængelig her.)');
        }
    }).catch(e => alert('Fejl: ' + e.message));
}
window._inbThreadCreateBon = _inbThreadCreateBon;

function _inbThreadOpenEntity() {
    const ent = _inbThreadEntity;
    if (!ent) return;
    if (ent.type === 'bon' && typeof window.openDrawer === 'function') window.openDrawer(ent.id);
    else if (ent.type === 'customer' && typeof window.openKunde360 === 'function') window.openKunde360(ent.id);
}
window._inbThreadOpenEntity = _inbThreadOpenEntity;

async function _inbLoadData() {
    if (!_inbActive) return;
    // Overskriften siger hvilken visning man står i — sæt den FØR hentningen,
    // så en fejl ikke efterlader forrige visnings overskrift over beskeden.
    const head0 = document.getElementById('inbListHead');
    if (head0) head0.textContent = 'Ufordelt — bounces + ukendt afsender';
    try {
        const params = new URLSearchParams();
        if (_inbFromDate) params.set('from_date', _inbFromDate);
        if (_inbMailbox) params.set('mailbox', _inbMailbox);
        // Ufordelt-mode: kun ufordelte mails (bounces + ukendt). Tråd-svar lever nu i
        // livscyklus-visningerne (Åbne/Afventer/…) via /mail/threads.
        const all = await apiFetch('/mail/inbox' + (params.toString() ? '?' + params.toString() : ''));
        _inbMails = all.filter(m => m.kind === 'unmatched');
        _inbRenderList();
        document.getElementById('inbCount').textContent = _inbMails.length;
        if (_inbComposing) {
            // Svar-komposer er åben — behold preview, opdatér kun liste/tæller
        } else if (_inbSelected) {
            const still = _inbMails.find(m => m.key === _inbSelected.key);
            if (still) _inbRenderPreview(still);
            else { _inbSelected = null; document.getElementById('inbPreview').innerHTML = '<div class="inb-empty">Vælg en mail fra listen</div>'; }
        }
    } catch (err) {
        _inbShowLoadError(err, 'ufordelt post');
    }
}

/**
 * Vis hvorfor listen er tom. Tidligere endte enhver load-fejl som et
 * console.error, så et 403 lignede "der er ingenting" — en office-bruger så
 * tælleren sige 3 og listen sige intet, uden at noget forklarede forskellen.
 */
function _inbShowLoadError(err, what) {
    console.error('[inbox] load ' + what + ':', err);
    const el = document.getElementById('inbList');
    if (!el) return;
    const msg = err && err.status === 403
        ? 'Din bruger har ikke adgang til ' + what + '.<br><span style="font-size:12px">Bed en administrator slå CRM til for din rolle under Indstillinger → Roller.</span>'
        : 'Kunne ikke hente ' + what + '.<br><span style="font-size:12px">' + _inbEscape((err && err.message) || 'Ukendt fejl') + '</span>';
    el.innerHTML = '<div class="inb-empty">' + msg + '</div>';
    const cnt = document.getElementById('inbCount');
    if (cnt) cnt.textContent = '—';
}

function _inbRenderList() {
    const el = document.getElementById('inbList');
    if (!el) return;

    if (!_inbMails.length) {
        el.innerHTML = '<div class="inb-empty">Ingen ufordelte mails</div>';
        return;
    }

    const ENTITY_ICON = { customer: '👤', bon: '🧾', purchase_order: '📦', supplier: '🚚', none: '✉' };
    const ENTITY_WORD = { customer: 'Kunde', bon: 'Bon', purchase_order: 'Indkøbsordre', supplier: 'Leverandør', none: 'Tråd' };

    el.innerHTML = _inbMails.map(m => {
        const isThread = m.kind === 'thread';
        // Tråd-svar: kun unmatched kan bulk-vælges/checkes
        const bounceBadge = m.is_bounce
            ? '<span class="inb-bounce-badge">🚨 BOUNCE</span>'
            : '';
        const bounceSubtitle = m.is_bounce && m.bounce_recipient
            ? '<div class="inb-mail-bounce-target">↳ ' + _inbEscape(m.bounce_recipient) +
              (m.bounce_customer_name ? ' · <strong>' + _inbEscape(m.bounce_customer_name) + '</strong>' : ' · <em>ukendt kunde</em>') +
              '</div>'
            : '';
        const entityChip = isThread
            ? '<div class="inb-entity-chip">' + (ENTITY_ICON[m.entity_type] || '✉') + ' ' +
              (ENTITY_WORD[m.entity_type] || 'Tråd') + ' · ' + _inbEscape(m.entity_label || '') + '</div>'
            : '';
        // 📎 i listen: tæl KUN rigtige vedhæftninger. Inline CID-billeder
        // (signatur-logoer o.l.) er der på næsten hver anden mail og ville
        // gøre badgen meningsløs.
        const attCount = (m.attachments || []).filter(a => a && !a.is_inline).length;
        const attBadge = attCount
            ? '<span class="inb-mail-att" title="' + attCount +
              (attCount === 1 ? ' vedhæftning' : ' vedhæftninger') + '">📎' +
              (attCount > 1 ? ' ' + attCount : '') + '</span>'
            : '';
        const canBulk = _inbBulkMode && !isThread;
        const isChecked = !isThread && _inbBulkSelected.has(m.id);
        const checkboxHtml = canBulk
            ? '<div class="inb-mail-check"><input type="checkbox" data-um-id="' + m.id + '"' + (isChecked ? ' checked' : '') + '></div>'
            : (_inbBulkMode && isThread ? '<div class="inb-mail-check"></div>' : '');
        const rowClasses = 'inb-mail-row'
            + (_inbSelected && _inbSelected.key === m.key ? ' selected' : '')
            + (isThread ? ' is-thread' : '')
            + (m.is_bounce ? ' is-bounce' : '')
            + (_inbBulkMode ? ' bulk-mode' : '')
            + (isChecked ? ' bulk-checked' : '');
        return '<div class="' + rowClasses + '" data-key="' + m.key + '" tabindex="0">' +
            checkboxHtml +
            '<div class="inb-mail-body">' +
                entityChip +
                '<div class="inb-mail-from">' + bounceBadge + (m.from_name || m.from_email || 'Ukendt') + '</div>' +
                '<div class="inb-mail-subject">' + (m.subject || '(intet emne)') + '</div>' +
                '<div class="inb-mail-meta">' +
                    '<span>' + (m.from_email || '') + '</span>' +
                    '<span>' + _inbFmtReceivedAt(m.received_at) + attBadge + '</span>' +
                '</div>' +
                bounceSubtitle +
                (m.parsed_company ? '<div class="inb-mail-parsed">→ ' + _inbEscape(m.parsed_company) + '</div>' : '') +
            '</div>' +
        '</div>';
    }).join('');

    el.querySelectorAll('.inb-mail-row').forEach(row => {
        const isThreadRow = !row.querySelector('input[type="checkbox"]') && row.classList.contains('is-thread');
        row.addEventListener('click', (e) => {
            if (_inbBulkMode && !isThreadRow) {
                if (e.target.tagName === 'INPUT') return; // checkbox håndteres separat
                const cb = row.querySelector('input[type="checkbox"]');
                if (cb) _inbBulkToggle(parseInt(cb.dataset.umId));
            } else {
                _inbSelectRow(row);
            }
        });
        const cb = row.querySelector('input[type="checkbox"]');
        if (cb) {
            cb.addEventListener('click', (e) => {
                e.stopPropagation();
                _inbBulkToggle(parseInt(cb.dataset.umId));
            });
        }
        row.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                const next = row.nextElementSibling;
                if (next && next.classList.contains('inb-mail-row')) {
                    next.focus();
                    _inbSelectRow(next);
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                const prev = row.previousElementSibling;
                if (prev && prev.classList.contains('inb-mail-row')) {
                    prev.focus();
                    _inbSelectRow(prev);
                }
            } else if (e.key === 'Enter') {
                _inbSelectRow(row);
            }
        });
    });
}

function _inbSelectRow(row) {
    const key = row.dataset.key;
    const mail = _inbMails.find(m => m.key === key);
    if (mail) {
        _inbComposing = false;
        _inbSelected = mail;
        document.querySelectorAll('.inb-mail-row').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        _inbRenderPreview(mail);
    }
}

function _inbRenderPreview(mail) {
    const el = document.getElementById('inbPreview');
    if (!el) return;

    // ── Tråd-svar (allerede routet til kunde/bon/PO/leverandør) ──
    // Vises her så indbakken ser ALT indgående. Handlinger: åbn hos entiteten
    // (hvor det fulde svar-flow lever) + markér læst (rydder fra indbakken).
    if (mail.kind === 'thread') {
        const ENTITY_WORD = { customer: 'kunde', bon: 'bon', purchase_order: 'indkøbsordre', supplier: 'leverandør', none: 'tråd' };
        const word = ENTITY_WORD[mail.entity_type] || 'tråd';
        const canOpen = mail.entity_type !== 'none' && mail.entity_id;
        el.innerHTML =
            '<div class="inb-preview-header">' +
                '<div class="inb-thread-banner">↪ Allerede knyttet til ' + word + ': <strong>' + _inbEscape(mail.entity_label || '') + '</strong></div>' +
                '<div class="inb-preview-from">' + (mail.from_name || 'Ukendt') + ' &lt;' + (mail.from_email || '') + '&gt;</div>' +
                '<div class="inb-preview-subject">' + (mail.subject || '(intet emne)') + '</div>' +
                '<div class="inb-preview-date">' + _inbFmtReceivedAt(mail.received_at) + ' · ' + (mail.mailbox || '') + '</div>' +
            '</div>' +
            '<div class="inb-preview-body" id="inbBodyHost"></div>' +
            '<div class="inb-actions">' +
                (canOpen ? '<button class="inb-action-btn primary" onclick="_inbOpenThreadEntity()">Åbn hos ' + word + ' →</button>' : '') +
                '<button class="inb-action-btn" onclick="_inbMarkThreadRead()">✓ Markér læst</button>' +
            '</div>';
        const bodyHost = document.getElementById('inbBodyHost');
        if (bodyHost) {
            if (window.MailThread && typeof MailThread.renderBody === 'function') MailThread.renderBody(bodyHost, mail);
            else bodyHost.textContent = mail.body_text || '';
        }
        return;
    }

    // Bounce-banner — vises prominent når mail er en bounce
    let bouncePanel = '';
    if (mail.is_bounce) {
        let customerLine = '';
        if (mail.bounce_customer_id) {
            const name = mail.bounce_customer_name || 'Ukendt';
            const company = mail.bounce_customer_company ? ' (' + _inbEscape(mail.bounce_customer_company) + ')' : '';
            const phone = mail.bounce_customer_phone
                ? '<a href="tel:' + _inbEscape(mail.bounce_customer_phone) + '" class="inb-bounce-tel">📞 ' + _inbEscape(mail.bounce_customer_phone) + '</a>'
                : '<span class="inb-bounce-no-phone">Intet telefonnummer</span>';
            customerLine =
                '<div class="inb-bounce-customer">' +
                    '<strong>' + _inbEscape(name) + '</strong>' + company + ' · ' + phone +
                '</div>' +
                '<div class="inb-bounce-actions">' +
                    '<button class="inb-action-btn primary" onclick="_inbOpenBounceCustomer(' + mail.bounce_customer_id + ')">' +
                        'Åbn kunde →' +
                    '</button>' +
                    '<button class="inb-action-btn" onclick="_inbMarkBounceHandled()">Markér som behandlet</button>' +
                '</div>';
        } else if (mail.bounce_recipient) {
            customerLine =
                '<div class="inb-bounce-customer inb-bounce-no-match">' +
                    'Ingen kunde med denne email i CRM — søg manuelt via "Link til Kunde" nedenfor' +
                '</div>';
        } else {
            customerLine =
                '<div class="inb-bounce-customer inb-bounce-no-match">' +
                    'Kunne ikke parse modtager-adressen ud af bouncen. Læs body manuelt.' +
                '</div>';
        }

        bouncePanel =
            '<div class="inb-bounce-panel">' +
                '<div class="inb-bounce-title">🚨 Mail blev IKKE leveret</div>' +
                (mail.bounce_recipient
                    ? '<div class="inb-bounce-recipient">Forsøgt sendt til: <code>' + _inbEscape(mail.bounce_recipient) + '</code></div>'
                    : '') +
                customerLine +
            '</div>';
    }

    // Inline-billeder vises kun hvis vi har HTML-kroppen. Mails modtaget før
    // migration 099 har ingen body_html → tilbyd "hent fra server" når teksten
    // røber et skjult CID-billede ([cid:...]).
    const hasHtml = !!(mail.body_html && String(mail.body_html).trim());
    const cidHint = !hasHtml && /\[?cid:/i.test(mail.body_text || '');
    const refetchBar = cidHint
        ? '<div class="inb-refetch-bar">🖼 Denne mail indeholder billeder der ikke er hentet endnu. ' +
          '<button class="inb-action-btn" id="inbRefetchBtn" onclick="_inbRefetch()">Hent billeder fra serveren</button></div>'
        : '';

    el.innerHTML =
        '<div class="inb-preview-header">' +
            '<div class="inb-preview-from">' + (mail.from_name || 'Ukendt') + ' &lt;' + (mail.from_email || '') + '&gt;</div>' +
            '<div class="inb-preview-subject">' + (mail.subject || '(intet emne)') + '</div>' +
            '<div class="inb-preview-date">' + _inbFmtReceivedAt(mail.received_at) + ' · ' + (mail.mailbox || '') + '</div>' +
        '</div>' +
        bouncePanel +
        refetchBar +
        '<div class="inb-preview-body" id="inbBodyHost"></div>' +
        '<div class="inb-actions">' +
            '<button class="inb-action-btn primary" onclick="_inbShowReply()">↩ Svar</button>' +
            '<button class="inb-action-btn" onclick="_inbCreateLead()">+ Opret lead</button>' +
            '<button class="inb-action-btn" onclick="_inbShowLinkBon()">Link til Bon</button>' +
            '<button class="inb-action-btn" onclick="_inbShowLinkKunde()">Link til Kunde</button>' +
            '<button class="inb-action-btn danger" onclick="_inbIgnore()">Ignorer</button>' +
        '</div>' +
        '<div id="inbLinkForm"></div>';

    // Render mail-kroppen: HTML-mails (med inline CID-billeder) i sandboxed iframe
    // via den fælles MailThread-komponent; ren-tekst escaped.
    const bodyHost = document.getElementById('inbBodyHost');
    if (bodyHost) {
        if (window.MailThread && typeof MailThread.renderBody === 'function') {
            MailThread.renderBody(bodyHost, mail);
        } else {
            bodyHost.textContent = mail.body_text || '';
        }
    }
}

async function _inbRefetch() {
    if (!_inbSelected) return;
    const btn = document.getElementById('inbRefetchBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Henter…'; }
    try {
        await refetchUnmatchedMail(_inbSelected.id);
        await _inbLoadData();   // genindlæser liste + re-renderer preview med body_html + billeder
    } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Prøv igen'; }
        alert('Kunne ikke hente billeder: ' + (e.message || 'fejl'));
    }
}
window._inbRefetch = _inbRefetch;

// ─── Bounce-handlers ────────────────────────────────────────

function _inbOpenBounceCustomer(customerId) {
    // Naviger til Kunde 360° (via Kontakter-tab i CRM)
    if (typeof window.openKunde360 === 'function') {
        window.openKunde360(customerId);
    } else if (typeof window.officeGoto === 'function') {
        window.officeGoto('crm', { pill: 'kontakter', tab: 'personer', customer: customerId });
    }
}
window._inbOpenBounceCustomer = _inbOpenBounceCustomer;

async function _inbMarkBounceHandled() {
    if (!_inbSelected) return;
    if (!confirm('Markér bouncen som behandlet?\n\nGør dette efter du har:\n  1. Kontaktet kunden\n  2. Opdateret deres email-adresse')) return;
    try {
        await patchUnmatchedMail(_inbSelected.id, { status: 'ignored' });
        _inbSelected = null;
        _inbLoadData();
        document.getElementById('inbPreview').innerHTML = '<div class="inb-empty">Bounce markeret som behandlet</div>';
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}
window._inbMarkBounceHandled = _inbMarkBounceHandled;

// ─── Tråd-svar-handlers (kind='thread') ─────────────────────

async function _inbMarkThreadRead() {
    if (!_inbSelected || _inbSelected.kind !== 'thread') return;
    try {
        await apiFetch('/mail/message/' + _inbSelected.message_id + '/read', { method: 'PATCH' });
        _inbSelected = null;
        _inbLoadData();
        document.getElementById('inbPreview').innerHTML = '<div class="inb-empty">✓ Markeret som læst</div>';
    } catch (err) {
        alert('Kunne ikke markere læst: ' + err.message);
    }
}
window._inbMarkThreadRead = _inbMarkThreadRead;

function _inbOpenThreadEntity() {
    const m = _inbSelected;
    if (!m || m.kind !== 'thread') return;
    if (m.entity_type === 'customer' && typeof window.openKunde360 === 'function') {
        window.openKunde360(m.entity_id);
    } else if (m.entity_type === 'bon' && typeof window.openDrawer === 'function') {
        window.openDrawer(m.entity_id);
    } else if ((m.entity_type === 'purchase_order' || m.entity_type === 'supplier') && typeof window.officeGoto === 'function') {
        window.officeGoto('leverandorpost');
    } else {
        alert('Kan ikke åbne denne tråd direkte — find den under ' + (m.entity_label || 'entiteten') + '.');
    }
}
window._inbOpenThreadEntity = _inbOpenThreadEntity;

function _inbEscape(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _inbFmtReceivedAt(s) {
    if (!s) return '';
    var d = parseServerDate(s);
    if (!d || isNaN(d.getTime())) return String(s).substring(0, 16);
    var pad = function(n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function _inbShowLinkBon() {
    const el = document.getElementById('inbLinkForm');
    if (!el) return;
    el.innerHTML =
        '<div class="inb-link-form">' +
            '<strong>Link til bon</strong>' +
            '<input type="text" class="inb-link-input" id="inbBonSearch" placeholder="Skriv bonnummer...">' +
            '<button class="inb-action-btn primary inb-link-submit" onclick="_inbLinkToBon()">Link</button>' +
        '</div>';
    document.getElementById('inbBonSearch').focus();
}

function _inbShowLinkKunde() {
    const el = document.getElementById('inbLinkForm');
    if (!el) return;
    el.innerHTML =
        '<div class="inb-link-form">' +
            '<strong>Link til kunde</strong>' +
            '<input type="text" class="inb-link-input" id="inbKundeSearch" placeholder="Søg kunde...">' +
            '<div id="inbKundeResults" style="margin-top:8px;"></div>' +
        '</div>';

    const input = document.getElementById('inbKundeSearch');
    input.focus();
    let debounce = null;
    input.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(async () => {
            if (!input.value.trim()) return;
            try {
                const rows = await fetchCrmCustomers({ q: input.value, limit: 5 });
                const resultsEl = document.getElementById('inbKundeResults');
                if (resultsEl) {
                    resultsEl.innerHTML = rows.map(r =>
                        '<div style="padding:6px 8px;cursor:pointer;border-bottom:1px solid #eee;" onclick="_inbLinkToCustomer(' + r.id + ')">' +
                            '<strong>' + r.name + '</strong>' +
                            (r.company_name ? ' · ' + r.company_name : '') +
                        '</div>'
                    ).join('');
                }
            } catch (err) { console.error(err); }
        }, 300);
    });
}

async function _inbLinkToBon() {
    if (!_inbSelected) return;
    const input = document.getElementById('inbBonSearch');
    const bonNumber = input ? input.value.trim().replace('#', '') : '';
    if (!bonNumber) { alert('Skriv et bonnummer'); return; }

    try {
        const bons = await apiFetch('/bons?q=' + encodeURIComponent(bonNumber) + '&limit=10');
        const rows = Array.isArray(bons) ? bons : (bons.rows || []);
        if (!rows.length) { alert('Bon ikke fundet'); return; }
        // Brugeren skriver typisk hele nummeret (cifre "4037" eller "B4037").
        // Foretræk eksakt bon_number-match, derefter eksakt cifre-match, ellers første.
        const typedDigits = bonNumber.replace(/\D/g, '');
        const match = rows.find(r => String(r.bon_number).toLowerCase() === bonNumber.toLowerCase())
                   || (typedDigits && rows.find(r => String(r.bon_number).replace(/\D/g, '') === typedDigits))
                   || rows[0];
        await patchUnmatchedMail(_inbSelected.id, { status: 'linked', linked_bon_id: match.id });
        _inbSelected = null;
        _inbLoadData();
        document.getElementById('inbPreview').innerHTML =
            '<div class="inb-empty">Mail linket til bon #' + match.bon_number +
            ' — ligger nu som tråd under <strong>Åbne</strong></div>';
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

async function _inbLinkToCustomer(customerId) {
    if (!_inbSelected) return;
    try {
        await patchUnmatchedMail(_inbSelected.id, { status: 'linked', linked_customer_id: customerId });
        _inbSelected = null;
        _inbLoadData();
        // Sig HVOR mailen tog hen — den forlader Ufordelt-listen, og uden et
        // pejlemærke er den svær at finde igen (jf. drifts-sagen aug. 2026).
        document.getElementById('inbPreview').innerHTML =
            '<div class="inb-empty">Mail linket til kunde — ligger nu som tråd under <strong>Åbne</strong></div>';
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

async function _inbIgnore() {
    if (!_inbSelected) return;
    if (!confirm('Ignorer denne mail?')) return;
    try {
        await patchUnmatchedMail(_inbSelected.id, { status: 'ignored' });
        _inbSelected = null;
        _inbLoadData();
        document.getElementById('inbPreview').innerHTML = '<div class="inb-empty">Mail ignoreret</div>';
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

// ─── Svar + opret lead ──────────────────────────────────────

function _inbEscapeAttr(str) {
    return _inbEscape(String(str || '')).replace(/"/g, '&quot;');
}

// Åbn svar-komposeren i preview-panelet. noteHtml = valgfri grøn status-linje øverst.
function _inbShowReply(noteHtml) {
    if (!_inbSelected) return;
    const el = document.getElementById('inbLinkForm');
    if (!el) return;
    _inbComposing = true;
    const m = _inbSelected;
    const reSubject = (m.subject && /^re:/i.test(m.subject.trim())) ? m.subject : ('Re: ' + (m.subject || ''));
    const fromKontakt = m.mailbox && m.mailbox.toLowerCase().indexOf('kontakt') !== -1;
    const mailboxLabel = fromKontakt ? 'kontakt@ristetrug.dk' : 'bon@ristetrug.dk';
    el.innerHTML =
        '<div class="inb-link-form">' +
            (noteHtml ? '<div style="color:#2e7d32;font-weight:700;font-size:12px;margin-bottom:8px">' + noteHtml + '</div>' : '') +
            '<strong>Svar til ' + _inbEscape(m.from_name || m.from_email || '') + '</strong>' +
            '<div style="font-size:11px;color:var(--color-text-dim);margin-top:4px">Til: ' + _inbEscape(m.from_email || '') + ' · sendes fra ' + mailboxLabel + '</div>' +
            '<input type="text" class="inb-link-input" id="inbReplySubject" value="' + _inbEscapeAttr(reSubject) + '">' +
            '<textarea class="inb-link-input" id="inbReplyText" rows="8" placeholder="Skriv dit svar…" style="resize:vertical;min-height:150px;line-height:1.6"></textarea>' +
            '<div style="display:flex;gap:8px;margin-top:8px">' +
                '<button class="inb-action-btn primary" id="inbReplySendBtn" onclick="_inbSendReply()">Send svar</button>' +
                '<button class="inb-action-btn" onclick="_inbCancelReply()">Annuller</button>' +
            '</div>' +
        '</div>';
    const ta = document.getElementById('inbReplyText');
    if (ta) ta.focus();
}
window._inbShowReply = _inbShowReply;

function _inbCancelReply() {
    _inbComposing = false;
    if (_inbSelected) _inbRenderPreview(_inbSelected);
}
window._inbCancelReply = _inbCancelReply;

async function _inbSendReply() {
    if (!_inbSelected) return;
    const subjEl = document.getElementById('inbReplySubject');
    const textEl = document.getElementById('inbReplyText');
    const btn = document.getElementById('inbReplySendBtn');
    const text = textEl ? textEl.value.trim() : '';
    if (!text) { alert('Skriv et svar først'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Sender…'; }
    try {
        await replyToUnmatchedMail(_inbSelected.id, { subject: subjEl ? subjEl.value : '', text: text });
        _inbComposing = false;
        _inbSelected = null;
        await _inbLoadData();
        document.getElementById('inbPreview').innerHTML = '<div class="inb-empty">✓ Svar sendt — afsenderen ligger nu som lead i CRM</div>';
    } catch (err) {
        if (btn) { btn.disabled = false; btn.textContent = 'Send svar'; }
        alert('Kunne ikke sende svar: ' + err.message);
    }
}
window._inbSendReply = _inbSendReply;

async function _inbCreateLead() {
    if (!_inbSelected) return;
    try {
        const res = await createLeadFromUnmatchedMail(_inbSelected.id);
        // Mailen er nu linket (forsvinder fra open-listen ved reload), men vi bliver
        // i preview og åbner svar-feltet med det samme.
        _inbSelected.status = 'linked';
        _inbSelected.linked_customer_id = res.customer_id;
        const word = res.created ? 'Lead oprettet' : 'Knyttet til eksisterende kunde';
        _inbShowReply('✓ ' + word + ' — du kan svare nu (eller åbne kunden i CRM)');
        _inbLoadData();   // opdatér liste + badge i baggrunden; preview bevares via _inbComposing
    } catch (err) {
        alert('Kunne ikke oprette lead: ' + err.message);
    }
}
window._inbCreateLead = _inbCreateLead;

// ─── Filter handlers ────────────────────────────────────────

function _inbSetMailbox(mb) {
    _inbMailbox = mb;
    _inbSelected = null;
    _inbThreadSel = null;
    _inbRenderShell();
    _inbLoad();
}

function _inbSetFromDate(d) {
    _inbFromDate = d || '';
    _inbSelected = null;
    _inbRenderShell();
    _inbRenderList();
    _inbLoadData();
}
window._inbSetFromDate = _inbSetFromDate;

// ─── Bulk-mode handlers ─────────────────────────────────────

function _inbToggleBulk() {
    _inbBulkMode = !_inbBulkMode;
    _inbBulkSelected = new Set();
    _inbSelected = null;
    _inbRenderShell();
    _inbRenderList();
    document.getElementById('inbCount').textContent = _inbMails.length;
    _inbUpdateBulkBar();
}
window._inbToggleBulk = _inbToggleBulk;

function _inbBulkToggle(id) {
    if (_inbBulkSelected.has(id)) _inbBulkSelected.delete(id);
    else _inbBulkSelected.add(id);
    _inbRenderList();
    _inbUpdateBulkBar();
}
window._inbBulkToggle = _inbBulkToggle;

function _inbBulkSelectAll() {
    // Kun ufordelte kan bulk-ignoreres — tråd-svar er allerede knyttet til en entitet
    _inbMails.forEach(m => { if (m.kind !== 'thread') _inbBulkSelected.add(m.id); });
    _inbRenderList();
    _inbUpdateBulkBar();
}
window._inbBulkSelectAll = _inbBulkSelectAll;

function _inbBulkClear() {
    _inbBulkSelected = new Set();
    _inbRenderList();
    _inbUpdateBulkBar();
}
window._inbBulkClear = _inbBulkClear;

function _inbUpdateBulkBar() {
    const countEl = document.getElementById('inbBulkCount');
    const btnEl = document.getElementById('inbBulkIgnoreBtn');
    const n = _inbBulkSelected.size;
    if (countEl) countEl.textContent = n + ' valgt';
    if (btnEl) {
        btnEl.disabled = n === 0;
        btnEl.textContent = n > 0 ? 'Ignorer ' + n + ' valgte' : 'Ignorer valgte';
    }
}

async function _inbBulkIgnore() {
    const ids = Array.from(_inbBulkSelected);
    if (!ids.length) return;
    if (!confirm('Ignorer ' + ids.length + ' mails?\n\nDe forsvinder fra ufordelt-listen og kan ikke nemt hentes tilbage.')) return;
    try {
        const res = await bulkIgnoreUnmatchedMails(ids);
        _inbBulkSelected = new Set();
        _inbBulkMode = false;
        _inbRenderShell();
        await _inbLoadData();
        console.log('[inbox] bulk-ignored:', res.updated);
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}
window._inbBulkIgnore = _inbBulkIgnore;

// ─── SSE handler ────────────────────────────────────────────

function _inbHandleSSE(eventType, data) {
    if (!_inbActive) return;
    // Genindlæs på enhver mail-bevægelse: ny ufordelt (mail_unmatched), nyt tråd-svar
    // (mail_received), tråd-status ændret (mail_thread_updated), eller markeret læst (mail_read).
    if (eventType === 'mail_unmatched' || eventType === 'mail_received'
        || eventType === 'mail_read' || eventType === 'mail_thread_updated') {
        _inbLoadCounts();
        // Undgå at klippe brugerens svar-komposer væk midt i skrivning
        if (!_inbComposing) _inbLoad();
    }
}
