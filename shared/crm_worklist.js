/**
 * shared/crm_worklist.js
 * ════════════════════════════════════════════════════════════
 * Delt "ringeliste"-komponent til CRM (#229, epic #232).
 *
 * En worklist er én arbejdsbar liste af kunder man ringer igennem og
 * logger udfaldet på — struktuelt identisk med office/views/crm-reaktivering.js
 * (kort + Ring/Log/Profil + inline log-formular + ListCampaignSelect +
 * "opret kampagne af listen"). Denne komponent parametriserer det mønster,
 * så sæson- og rytme-listerne (#230) er ~konfig frem for kode-kloner.
 *
 * Instans-baseret (factory), IKKE modul-globaler som crm-reaktivering.js —
 * fordi den fanebaserede Ringeliste (crm-ringeliste.js) hoster flere
 * worklists side om side og skifter mellem dem.
 *
 *   const wl = CrmWorklist.create({
 *       key:        'season',                 // stabil id (bruges til snooze-type)
 *       title:      'Sæson',
 *       subtitle:   (n) => `${n} kunder bestilte på denne tid sidste år`,
 *       emptyText:  'Ingen sæson-emner lige nu.',
 *       fetchRows:  () => fetchCrmSeason(),    // () => Promise<row[]>
 *       purposeKey: 'saesonoutreach',          // activity_purposes.key logget ved "Gem"
 *       campaignType: 'seasonal',              // POST /api/campaigns/from-suggestion type
 *       contextName:  'Sæson',                 // ListCampaignSelect label
 *       suggestedCampaignName: () => 'Sæson ' + new Date().getFullYear(),
 *       // Række-adaptere (hver liste har sin egen kolonne-form):
 *       getCustomerId: (r) => r.customer_id,
 *       getCompanyId:  (r) => r.company_id,
 *       getName:       (r) => r.name,
 *       getPhone:      (r) => r.phone,
 *       buildMeta:     (r) => `${r.company_name || 'Privat'} · ${r.pax} pax`,
 *       buildOpener:   (r) => `Sidste år: ${r.pax} pax d. ${r.last_year_date}`,
 *   });
 *   wl.mount(containerEl);   // renderer + henter data
 *   wl.reload();             // gen-hent
 *   wl.handleSSE(eventName); // debounced reload på crm_activity_created m.fl.
 *   wl.unmount();            // ryd op (detacher ListCampaignSelect)
 *
 * Afhænger af (alle allerede i office-zonen):
 *   window.ListCampaignSelect, window.AddToCampaignModal,
 *   fetchActivityPurposes(), postCrmActivity(),
 *   snoozeSuggestion(), createCampaignFromSuggestion(),
 *   window.openKunde360().
 * ════════════════════════════════════════════════════════════
 */

(function () {
    'use strict';

    let _seq = 0;                 // unik id-prefix pr. instans (flere worklists i DOM)
    let _purposesCache = null;    // activity_purposes deles på tværs af instanser

    const SSE_RELOAD_EVENTS = ['crm_activity_created', 'crm_stage_changed', 'rfm_computed'];

    function ensureStyles() {
        if (document.getElementById('crm-worklist-styles')) return;
        const s = document.createElement('style');
        s.id = 'crm-worklist-styles';
        s.textContent = `
            .wl-wrap { }
            .wl-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
            .wl-sub { color: #888; font-size: 13px; }
            .wl-toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; align-items: center; }
            .wl-card { background: #fff; border: 1px solid var(--color-border, #d7d1ca); border-radius: 8px;
                       padding: 16px; margin-bottom: 12px; transition: box-shadow 0.2s; cursor: pointer; }
            .wl-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
            /* Vælg-til-kampagne checkbox — vises kun når select-mode er slået til
               (ListCampaignSelect sætter [data-cselect="on"] på liste-containeren). */
            .wl-check { display: none; }
            [data-cselect="on"] .wl-card { position: relative; padding-left: 48px; }
            [data-cselect="on"] .wl-check {
                display: flex; align-items: center; justify-content: center;
                position: absolute; left: 16px; top: 18px;
                width: 20px; height: 20px; border-radius: 5px;
                border: 2px solid var(--color-border, #d7d1ca);
                background: #fff; color: #fff; font-size: 13px; line-height: 1;
                transition: background 0.12s, border-color 0.12s;
            }
            .wl-card.csel-checked .wl-check {
                background: var(--brand-primary, #8e631f);
                border-color: var(--brand-primary, #8e631f);
            }
            .wl-card.csel-checked .wl-check::after { content: '✓'; }
            .wl-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
            .wl-name { font-size: 16px; font-weight: 600; }
            .wl-name[title] { cursor: pointer; }
            .wl-meta { font-size: 12px; color: #888; margin-top: 3px; }
            .wl-opener { background: #f9f7f4; border-radius: 6px; padding: 10px; margin-top: 10px; font-size: 13px;
                         font-style: italic; color: #555; }
            .wl-actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
            .wl-btn { padding: 6px 14px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px;
                      font-family: inherit; }
            .wl-btn-call { background: #3d7a0a; color: #fff; }
            .wl-btn-call:hover { background: #2d5a07; }
            .wl-btn-ghost { background: #f0ece6; color: #333; }
            .wl-btn-ghost:hover { filter: brightness(0.97); }
            .wl-btn-snooze { background: transparent; color: #999; border: 1px solid var(--color-border, #d7d1ca); }
            .wl-btn-snooze:hover { color: #666; background: #f7f5f2; }
            .wl-log { background: #faf8f5; border-radius: 6px; padding: 12px; margin-top: 10px; display: none; }
            .wl-log.open { display: block; }
            .wl-log select { padding: 4px 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; margin-right: 8px; }
            .wl-log textarea { width: 100%; min-height: 60px; border: 1px solid #ccc; border-radius: 4px;
                               padding: 6px; font-size: 13px; resize: vertical; margin-top: 8px; box-sizing: border-box; }
            .wl-empty { text-align: center; padding: 40px; color: #888; }
            .wl-err { color: #b00; padding: 16px; }
            .wl-scores { display: flex; gap: 10px; align-items: center; flex-shrink: 0; }
            .wl-score { font-size: 11px; color: #888; text-align: center; line-height: 1.1; }
            .wl-score b { display: block; font-size: 16px; color: #333; font-weight: 700; }
            .wl-potential { font-size: 22px; font-weight: 700; font-family: var(--font-heading, serif);
                            color: var(--brand-primary, #8e631f); margin-left: 4px; }
            .wl-controls:empty { display: none; }
            .wl-config { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 12px;
                         font-size: 12px; color: #666; background: #faf8f5; border: 1px solid var(--color-border, #d7d1ca);
                         border-radius: 8px; padding: 8px 12px; }
            .wl-config label { display: flex; align-items: center; gap: 6px; }
            .wl-cfg-input { width: 52px; padding: 5px 7px; border: 1px solid #ccc; border-radius: 6px;
                            font-size: 13px; text-align: right; }
            .wl-cfg-hint { color: #999; }
        `;
        document.head.appendChild(s);
    }

    function esc(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function attr(s) {
        return esc(s).replace(/"/g, '&quot;');
    }

    function create(config) {
        if (!config || !config.key || typeof config.fetchRows !== 'function') {
            throw new Error('CrmWorklist.create: kræver { key, fetchRows }');
        }
        const cfg = Object.assign({
            title: config.key,
            subtitle: (n) => `${n} emner`,
            emptyText: 'Ingen emner lige nu.',
            purposeKey: null,
            campaignType: null,
            contextName: config.title || config.key,
            suggestedCampaignName: () => config.title || config.key,
            getCustomerId: (r) => r.customer_id,
            getCompanyId: (r) => r.company_id || null,
            getBonId: () => null,   // bon-centrerede lister (fx cold_offer) → dedupe pr. tilbud
            getName: (r) => r.name || r.customer_name || '',
            getPhone: (r) => r.phone || null,
            buildMeta: (r) => r.company_name || '',
            buildOpener: () => null,
            buildExtra: () => '',        // valgfri ekstra HTML i kortet (fx RFM-scorer)
            renderControls: null,        // valgfri (el, { meta, reload }) → data-afhængig config-bar
        }, config);

        const uid = 'wl' + (++_seq);
        const state = {
            container: null,
            listEl: null,
            active: false,
            rows: null,
            meta: null,      // valgfri config/meta fra { rows, config }-svar
            debounce: null,
        };

        function mount(container) {
            ensureStyles();
            state.container = container;
            state.active = true;
            container.innerHTML = `
                <div class="wl-wrap">
                    <div class="wl-head">
                        <span class="wl-sub" id="${uid}-sub">Indlæser…</span>
                    </div>
                    <div class="wl-toolbar" id="${uid}-toolbar"></div>
                    <div class="wl-controls" id="${uid}-controls"></div>
                    <div id="${uid}-list"></div>
                </div>`;
            state.listEl = container.querySelector('#' + uid + '-list');
            _renderCampaignButton();
            _wireSelect();
            loadData();
        }

        function unmount() {
            state.active = false;
            if (state.debounce) clearTimeout(state.debounce);
            if (window.ListCampaignSelect) window.ListCampaignSelect.detach();
            state.container = null;
            state.listEl = null;
            state.rows = null;
        }

        function handleSSE(event) {
            if (!state.active) return;
            if (SSE_RELOAD_EVENTS.includes(event)) {
                if (state.debounce) clearTimeout(state.debounce);
                state.debounce = setTimeout(loadData, 2000);
            }
        }

        function reload() { loadData(); }

        async function loadData() {
            if (!state.active) return;
            try {
                const [rows, purposes] = await Promise.all([
                    cfg.fetchRows(),
                    _purposesCache ? Promise.resolve(_purposesCache) : fetchActivityPurposes(),
                ]);
                _purposesCache = purposes;
                state.rows = Array.isArray(rows) ? rows : (rows && rows.rows) || [];
                state.meta = (rows && !Array.isArray(rows) && (rows.config || rows.meta)) || null;
                _render();
            } catch (err) {
                if (state.listEl) state.listEl.innerHTML = '<div class="wl-err">Fejl: ' + esc(err.message) + '</div>';
            }
        }

        function _renderCampaignButton() {
            // "Opret kampagne af hele listen" — kun hvis dispatchen understøtter typen
            if (!cfg.campaignType) return;
            const tb = state.container.querySelector('#' + uid + '-toolbar');
            if (!tb) return;
            const btn = document.createElement('button');
            btn.className = 'wl-btn wl-btn-ghost';
            btn.type = 'button';
            btn.textContent = '📣 Opret kampagne af listen';
            btn.title = 'Læg alle emner på listen ind i en outreach-kampagne';
            btn.addEventListener('click', _createCampaignFromList);
            tb.appendChild(btn);
        }

        function _wireSelect() {
            if (!window.ListCampaignSelect) return;
            const toolbar = state.container.querySelector('#' + uid + '-toolbar');
            const host = state.listEl;
            if (!toolbar || !host) return;
            window.ListCampaignSelect.attach({
                hostEl: host,
                toolbarEl: toolbar,
                contentEl: host,
                rowSelector: '.wl-card',
                getEntityFromRow: (row) => ({
                    company_id: parseInt(row.dataset.companyId, 10) || null,
                    customer_id: parseInt(row.dataset.customerId, 10) || null,
                    name: row.dataset.name || '',
                }),
                contextName: cfg.contextName,
                suggestedCampaignName: cfg.suggestedCampaignName,
            });
        }

        function _render() {
            if (!state.active || !state.rows) return;
            const sub = document.getElementById(uid + '-sub');
            if (sub) sub.textContent = cfg.subtitle(state.rows.length);

            if (cfg.renderControls) {
                const cEl = state.container && state.container.querySelector('#' + uid + '-controls');
                if (cEl) cfg.renderControls(cEl, { meta: state.meta, reload: loadData });
            }

            const list = state.listEl;
            if (!list) return;

            if (state.rows.length === 0) {
                list.innerHTML = '<div class="wl-empty">' + esc(cfg.emptyText) + '</div>';
                if (window.ListCampaignSelect) window.ListCampaignSelect.refresh();
                return;
            }

            list.innerHTML = state.rows.map((r, i) => {
                const name = cfg.getName(r);
                const cid = cfg.getCustomerId(r) || 0;
                const compId = cfg.getCompanyId(r) || 0;
                const phone = cfg.getPhone(r);
                const meta = cfg.buildMeta(r);
                const opener = cfg.buildOpener(r);
                const nameTitle = cid ? ' title="Åbn kundeprofil"' : '';
                const phoneClean = phone ? String(phone).replace(/\s/g, '') : '';
                return `
                <div class="wl-card" id="${uid}-card-${i}" data-idx="${i}"
                     data-company-id="${compId}" data-customer-id="${cid}" data-name="${attr(name)}">
                    <span class="wl-check" aria-hidden="true"></span>
                    <div class="wl-top">
                        <div>
                            <div class="wl-name"${nameTitle}>${esc(name)}</div>
                            <div class="wl-meta">${meta || ''}</div>
                        </div>
                        ${cfg.buildExtra ? (cfg.buildExtra(r) || '') : ''}
                    </div>
                    ${opener ? '<div class="wl-opener">' + esc(opener) + '</div>' : ''}
                    <div class="wl-actions">
                        ${phone ? '<a href="tel:' + attr(phoneClean) + '" class="wl-btn wl-btn-call" onclick="event.stopPropagation()">📞 Ring</a>' : ''}
                        <button class="wl-btn wl-btn-call" data-act="log">📝 Log</button>
                        <button class="wl-btn wl-btn-ghost" data-act="profile">Profil →</button>
                        <button class="wl-btn wl-btn-snooze" data-act="snooze" title="Skjul dette emne i 14 dage">🙈 Skjul</button>
                    </div>
                    <div class="wl-log" id="${uid}-log-${i}">
                        <select id="${uid}-result-${i}">
                            <option value="reached">Nået</option>
                            <option value="no_answer">Ingen svar</option>
                            <option value="voicemail">Voicemail</option>
                            <option value="callback">Ring tilbage</option>
                        </select>
                        <select id="${uid}-sentiment-${i}">
                            <option value="">Stemning…</option>
                            <option value="positive">😊 Positiv</option>
                            <option value="neutral">😐 Neutral</option>
                            <option value="negative">😟 Negativ</option>
                        </select>
                        <textarea id="${uid}-note-${i}" placeholder="Note…"></textarea>
                        <div style="margin-top:8px">
                            <button class="wl-btn wl-btn-call" data-act="save">Gem</button>
                            <button class="wl-btn wl-btn-ghost" data-act="cancel">Annuller</button>
                        </div>
                    </div>
                </div>`;
            }).join('');

            _bindListClicks();
            if (window.ListCampaignSelect) window.ListCampaignSelect.refresh();
        }

        function _bindListClicks() {
            const list = state.listEl;
            if (!list || list._wlBound) return;
            list.addEventListener('click', (e) => {
                const btn = e.target.closest('button[data-act], a');
                const card = e.target.closest('.wl-card');
                if (!card) return;
                const idx = parseInt(card.dataset.idx, 10);

                if (btn && btn.dataset && btn.dataset.act) {
                    e.stopPropagation();
                    const act = btn.dataset.act;
                    if (act === 'log') _showLog(idx);
                    else if (act === 'cancel') _hideLog(idx);
                    else if (act === 'save') _submitLog(idx);
                    else if (act === 'snooze') _snooze(idx);
                    else if (act === 'profile') _openProfile(cfg.getCustomerId(state.rows[idx]) || 0);
                    return;
                }
                // Klik på tel:-link håndteres af browseren (stopPropagation i markup)
                if (e.target.closest('a, select, textarea, input')) return;

                // Bare-klik på kort: select-mode toggles valg, ellers åbn profil
                if (window.ListCampaignSelect && window.ListCampaignSelect.handleRowClick(card)) return;
                _openProfile(cfg.getCustomerId(state.rows[idx]) || 0);
            });
            list._wlBound = true;
        }

        function _showLog(idx) {
            const f = document.getElementById(uid + '-log-' + idx);
            if (f) f.classList.add('open');
        }
        function _hideLog(idx) {
            const f = document.getElementById(uid + '-log-' + idx);
            if (f) f.classList.remove('open');
        }

        async function _submitLog(idx) {
            if (!state.active || !state.rows[idx]) return;
            const r = state.rows[idx];
            const result = document.getElementById(uid + '-result-' + idx)?.value;
            const sentiment = document.getElementById(uid + '-sentiment-' + idx)?.value || null;
            const note = document.getElementById(uid + '-note-' + idx)?.value?.trim();
            if (!note) { alert('Skriv en note'); return; }

            const purpose = (_purposesCache || []).find(p => p.key === cfg.purposeKey);
            const bonId = cfg.getBonId ? cfg.getBonId(r) : null;
            try {
                await postCrmActivity({
                    customer_id: cfg.getCustomerId(r),
                    bon_id: bonId || null,   // sat for bon-centrerede lister (cold_offer) → dedupe pr. tilbud
                    type: 'call',
                    result,
                    sentiment,
                    text: note,
                    purpose_id: purpose?.id || null,
                });
                _hideLog(idx);
                const card = document.getElementById(uid + '-card-' + idx);
                if (card) card.style.opacity = '0.3';
                setTimeout(loadData, 1000);   // SSE reloader også, men vær sikker
            } catch (err) {
                alert('Fejl: ' + err.message);
            }
        }

        async function _snooze(idx) {
            if (!state.rows[idx]) return;
            const cid = cfg.getCustomerId(state.rows[idx]);
            if (!cid) return;
            try {
                await snoozeSuggestion({ customer_id: cid, type: cfg.key });
                const card = document.getElementById(uid + '-card-' + idx);
                if (card) card.style.opacity = '0.3';
                setTimeout(loadData, 400);
            } catch (err) {
                alert('Kunne ikke skjule: ' + err.message);
            }
        }

        function _openProfile(customerId) {
            if (customerId && typeof window.openKunde360 === 'function') window.openKunde360(customerId);
        }

        async function _createCampaignFromList() {
            if (!cfg.campaignType || typeof createCampaignFromSuggestion !== 'function') return;
            const name = (cfg.suggestedCampaignName && cfg.suggestedCampaignName()) || cfg.title;
            const campaignName = prompt('Navn på kampagne:', name);
            if (!campaignName) return;
            try {
                const res = await createCampaignFromSuggestion({ type: cfg.campaignType, campaign_name: campaignName });
                const added = res && (res.added ?? res.members_added);
                alert('Kampagne oprettet' + (added != null ? ' med ' + added + ' medlemmer' : '') + '.');
            } catch (err) {
                alert('Kunne ikke oprette kampagne: ' + err.message);
            }
        }

        return { key: cfg.key, title: cfg.title, mount, unmount, reload, handleSSE };
    }

    window.CrmWorklist = { create };
})();
