/**
 * shared/mail_compose.js
 * ════════════════════════════════════════════════════════════
 * Delt mail-formular til kunde-mail (skabelon · emne · besked · vedhæftning ·
 * booking-link). Afsendelse går gennem POST /api/customers/:id/mail, som
 * substituerer {{booking_link}} server-side og logger en `email_out`-aktivitet.
 *
 * Hvorfor delt: formularen lå inde i office/views/crm-kunde360.js og kunne ikke
 * kaldes andre steder fra. Service-kald og ringelisterne havde derfor kun et
 * `mailto:`-link — og dét kan pr. konstruktion IKKE bære et booking-link, fordi
 * tokenet genereres på serveren og bindes til (kunde, sælger, flow, mødetype).
 * Samme greb som MailThread.renderHistory: én kilde frem for en fjerde kopi.
 *
 *   const mc = MailCompose.create({ customerId, customer, purposeKey });
 *   mc.render(el);                 // inline (Kunde 360°'s Mail-fane)
 *   mc.destroy();
 *
 *   MailCompose.open({ ... });     // modal (service-kald, ringeliste, kampagne)
 *
 * Options:
 *   customerId   (påkrævet) — mailen sendes til kundens tråd (#k-NNN)
 *   customer     { first_name, last_name, company_name, phone, email } til skabelon-variabler
 *   to/subject/body  forudfyldning
 *   bonId        valgfri — mailen hænger på bonen (service-kald dedupe'r på den)
 *   purposeKey   valgfri — fx 'saesonoutreach', så ringelisten dedupe'r
 *   campaignId   valgfri — tilskriv kampagnen
 *   title        overskrift i modal-tilstand
 *   onSent(res)  kaldes efter vellykket afsendelse
 * ════════════════════════════════════════════════════════════
 */

(function () {
    'use strict';

    let _seq = 0;
    let _templatesCache = null;     // mail_templates deles på tværs af instanser
    let _meetingTypesCache = null;  // mødetyper til booking-link-popoveren

    const BOOKING_TOKEN = '{{booking_link}}';
    const MAX_ATTACHMENTS = 5;
    const MAX_BYTES = 10 * 1024 * 1024;

    function esc(s) {
        return (typeof escapeHtml === 'function') ? escapeHtml(s)
            : String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function attr(s) { return esc(s).replace(/"/g, '&quot;'); }

    function ensureStyles() {
        if (document.getElementById('mail-compose-styles')) return;
        const s = document.createElement('style');
        s.id = 'mail-compose-styles';
        s.textContent = `
            .mc-field { margin-bottom: 10px; }
            .mc-field > label { display: block; font-size: 11px; text-transform: uppercase;
                                letter-spacing: .04em; color: var(--color-text-dim, #888); margin-bottom: 4px; }
            .mc-input { width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 14px;
                        font-family: inherit; border: 1px solid var(--color-border, #d7d1ca); border-radius: 6px; }
            .mc-body { width: 100%; box-sizing: border-box; min-height: 170px; padding: 10px;
                       font-size: 14px; font-family: inherit; line-height: 1.5; resize: vertical;
                       border: 1px solid var(--color-border, #d7d1ca); border-radius: 6px; }
            .mc-actions { display: flex; gap: 8px; margin-top: 8px; align-items: center;
                          flex-wrap: wrap; position: relative; }
            .mc-btn { padding: 6px 12px; font-size: 13px; font-family: inherit; cursor: pointer;
                      border: 1px solid var(--color-border, #d7d1ca); border-radius: 6px;
                      background: var(--color-surface, #fff); color: #333; }
            .mc-btn:hover:not(:disabled) { background: var(--brand-primary-light, #f1e6b2); }
            .mc-btn:disabled { opacity: .5; cursor: default; }
            .mc-send { margin-left: auto; padding: 8px 18px; font-size: 14px; font-weight: 600;
                       font-family: inherit; cursor: pointer; border: none; border-radius: 6px;
                       background: var(--brand-primary, #8e631f); color: #fff; }
            .mc-send:disabled { opacity: .6; cursor: default; }
            .mc-info { font-size: 11px; color: var(--color-text-dim, #888); }
            .mc-warn { margin-top: 6px; padding: 7px 10px; font-size: 12px; border-radius: 6px;
                       background: var(--color-sentiment-neu-bg, #FBF3E2); color: #7a5c14;
                       border: 1px solid #e6d9ae; }
            .mc-warn code { background: rgba(0,0,0,.06); padding: 1px 4px; border-radius: 3px; }
            .mc-pill { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; margin: 3px 4px 0 0;
                       font-size: 12px; border-radius: 12px; background: var(--color-background, #f5f4f2);
                       border: 1px solid var(--color-border, #d7d1ca); }
            .mc-pill-x { cursor: pointer; color: var(--color-text-dim, #888); font-weight: 700; }
            .mc-pill-x:hover { color: var(--color-sentiment-neg, #b00); }
            /* Popoveren folder OP, ikke ned: handlings-rækken ligger nederst i
               formularen, og i modal-tilstand klipper .mc-modal's overflow-y
               alt under den — popoveren var kun halvt synlig. */
            .mc-pop { position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 60; min-width: 290px; padding: 12px;
                      background: #fff; border: 1px solid var(--color-border, #d7d1ca); border-radius: 8px;
                      box-shadow: 0 6px 20px rgba(0,0,0,.12); display: none; }
            .mc-pop.open { display: block; }
            .mc-pop-title { font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
                            color: var(--color-text-dim, #888); margin-bottom: 6px; }
            .mc-pop label.mc-radio { display: flex; align-items: center; gap: 6px; cursor: pointer;
                                     font-size: 13px; margin-bottom: 3px; }
            .mc-pop select { width: 100%; padding: 5px 6px; font-size: 13px; font-family: inherit;
                             border: 1px solid var(--color-border, #d7d1ca); border-radius: 4px; }
            .mc-pop-foot { display: flex; gap: 6px; justify-content: flex-end; margin-top: 10px; }
            /* Modal-tilstand */
            .mc-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 900;
                          display: flex; align-items: flex-start; justify-content: center; padding: 40px 16px; }
            .mc-modal { background: #fff; border-radius: 10px; width: 100%; max-width: 640px;
                        max-height: calc(100vh - 80px); overflow-y: auto; box-shadow: 0 10px 40px rgba(0,0,0,.25); }
            .mc-modal-head { display: flex; align-items: center; gap: 10px; padding: 14px 20px;
                             border-bottom: 1px solid var(--color-border, #d7d1ca);
                             font-family: var(--font-heading, Georgia, serif); font-size: 17px; font-weight: 700; }
            .mc-modal-x { margin-left: auto; background: none; border: none; font-size: 20px; line-height: 1;
                          cursor: pointer; color: var(--color-text-dim, #888); }
            .mc-modal-body { padding: 18px 20px; }
            .mc-sub { font-size: 12px; color: var(--color-text-dim, #888); font-weight: 400;
                      font-family: var(--font-body, inherit); }
        `;
        document.head.appendChild(s);
    }

    function create(opts) {
        if (!opts || !opts.customerId) throw new Error('MailCompose: customerId kræves');
        ensureStyles();

        const uid = 'mc' + (++_seq);
        const st = {
            el: null,
            attachments: [],
            bookingFlow: 'smagning',
            bookingIntent: null,
            sending: false,
            outsideHandler: null,
        };
        const id = (suffix) => uid + '-' + suffix;
        const $ = (suffix) => st.el && st.el.querySelector('#' + id(suffix));

        function render(container) {
            st.el = container;
            container.innerHTML = `
                <div class="mc-wrap" data-mc="${uid}">
                    <div class="mc-field">
                        <label for="${id('to')}">Til</label>
                        <input type="email" class="mc-input" id="${id('to')}" value="${attr(opts.to || opts.customer?.email || '')}">
                    </div>
                    ${opts.showTemplates === false ? '' : `
                    <div class="mc-field">
                        <label for="${id('tmpl')}">Skabelon</label>
                        <select class="mc-input" id="${id('tmpl')}"><option value="">— Ingen skabelon —</option></select>
                        <div id="${id('tmplwarn')}"></div>
                    </div>`}
                    <div class="mc-field">
                        <label for="${id('subject')}">Emne</label>
                        <input type="text" class="mc-input" id="${id('subject')}" placeholder="Emne…" value="${attr(opts.subject || '')}">
                    </div>
                    <div class="mc-field">
                        <label for="${id('body')}">Besked</label>
                        <textarea class="mc-body" id="${id('body')}" placeholder="Skriv din besked…">${esc(opts.body || '')}</textarea>
                        <div id="${id('sighint')}"></div>
                    </div>
                    <input type="file" id="${id('file')}" accept=".pdf,.jpg,.jpeg,.png,.gif,.xlsx,.docx" style="display:none">
                    <div id="${id('atts')}"></div>
                    <div class="mc-actions">
                        <button type="button" class="mc-btn" id="${id('attach')}">📎 Vedhæft</button>
                        <button type="button" class="mc-btn" id="${id('booking')}">📅 Indsæt booking-link</button>
                        <span class="mc-info" id="${id('bookinginfo')}"></span>
                        <button type="button" class="mc-send" id="${id('send')}">Send mail</button>
                        <div class="mc-pop" id="${id('pop')}">
                            <div class="mc-pop-title">Booking-link</div>
                            <label class="mc-radio"><input type="radio" name="${id('flow')}" value="smagning" checked> Smagsprøve (kalender-side)</label>
                            <label class="mc-radio"><input type="radio" name="${id('flow')}" value="kontakt"> Kontaktformular</label>
                            <div id="${id('intentrow')}" style="margin-top:8px;">
                                <div class="mc-pop-title" style="margin-bottom:3px;">Forvalgt mødetype</div>
                                <select id="${id('intent')}"><option value="">— ingen forvalgt —</option></select>
                            </div>
                            <div class="mc-pop-foot">
                                <button type="button" class="mc-btn" id="${id('popcancel')}">Annuller</button>
                                <button type="button" class="mc-send" style="margin-left:0;padding:5px 12px;font-size:13px;" id="${id('popinsert')}">Indsæt</button>
                            </div>
                        </div>
                    </div>
                </div>`;

            $('attach').addEventListener('click', _attachFile);
            $('file').addEventListener('change', _onFileSelected);
            $('booking').addEventListener('click', _toggleBookingPopover);
            $('popcancel').addEventListener('click', _closeBookingPopover);
            $('popinsert').addEventListener('click', _insertBookingLink);
            $('send').addEventListener('click', _send);
            if ($('tmpl')) {
                $('tmpl').addEventListener('change', _applyTemplate);
                _loadTemplates();
            }
            if (typeof MailThread !== 'undefined' && MailThread.renderSignatureHint) {
                MailThread.renderSignatureHint($('sighint'));
            }

            // Popoveren har intet overlay, så den lukker fra en document-lytter.
            // clickedOutsideSelector kender reglen om at en museop-slip efter en
            // tekstmarkering ikke er et "klik udenfor" (se shared/utils.js).
            st.outsideHandler = (e) => {
                const pop = $('pop');
                if (!pop || !pop.classList.contains('open')) return;
                if (typeof clickedOutside === 'function'
                    ? clickedOutside(e, pop, $('booking'))
                    : !pop.contains(e.target) && e.target !== $('booking')) {
                    _closeBookingPopover();
                }
            };
            document.addEventListener('click', st.outsideHandler);
            return api;
        }

        function destroy() {
            if (st.outsideHandler) document.removeEventListener('click', st.outsideHandler);
            st.outsideHandler = null;
            st.el = null;
        }

        /* ── Skabeloner ─────────────────────────────────────── */
        // Skabelonerne er skrevet til en BON ({{bonNummer}}, {{leveringsDato}}, menuen…).
        // Herinde findes der ingen bon — kun en kunde. Vi udfylder det vi kan og siger
        // tydeligt hvad der mangler, frem for at lade som om skabelonen passer.
        async function _loadTemplates() {
            const sel = $('tmpl');
            if (!sel) return;
            try {
                if (!_templatesCache) _templatesCache = await fetchMailTemplates();
                sel.innerHTML = '<option value="">— Ingen skabelon —</option>' +
                    (_templatesCache || []).map(t =>
                        '<option value="' + attr(t.key) + '">' + esc(t.label || t.key) + '</option>').join('');
            } catch (err) {
                console.error('[mail_compose] Kunne ikke hente skabeloner:', err);
                sel.innerHTML = '<option value="">— skabeloner kunne ikke hentes —</option>';
            }
        }

        function _templateVars() {
            const c = opts.customer || {};
            // Navnefelterne i driften bærer stedvis linjeskift (fx last_name = "\n zeeberg").
            // Et navn må aldrig brække en hilsen midt over — så mellemrum normaliseres.
            const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
            const navn = clean((c.first_name || '') + ' ' + (c.last_name || ''));
            return {
                kundeNavn: navn || clean(c.company_name) || '',
                fornavn: clean(c.first_name),
                firmanavn: clean(c.company_name),
                telefon: clean(c.phone),
                tag: '',   // serveren sætter selv #k-NNN på emnet
            };
        }

        function _applyTemplate() {
            const sel = $('tmpl'), warn = $('tmplwarn'), subj = $('subject'), body = $('body');
            if (!sel || !subj || !body) return;
            if (!sel.value) { warn.innerHTML = ''; return; }
            const tmpl = (_templatesCache || []).find(t => t.key === sel.value);
            if (!tmpl) return;
            // Overskriv ikke noget brugeren allerede har skrevet uden at spørge.
            if ((subj.value.trim() || body.value.trim()) &&
                !confirm('Erstat det du har skrevet med skabelonen "' + (tmpl.label || tmpl.key) + '"?')) {
                sel.value = '';
                return;
            }
            const vars = _templateVars();
            const subst = (str) => {
                let r = str || '';
                for (const [k, v] of Object.entries(vars)) r = r.replace(new RegExp('\\{\\{' + k + '\\}\\}', 'g'), v);
                return r;
            };
            subj.value = subst(tmpl.subject).trim();
            body.value = subst(tmpl.body_text);

            const rest = unresolvedVars(subj.value + '\n' + body.value);
            warn.innerHTML = rest.length
                ? '<div class="mc-warn">⚠ ' + rest.length + ' pladsholder' + (rest.length === 1 ? '' : 'e') +
                  ' kunne ikke udfyldes — skabelonen er skrevet til en bon: <code>' +
                  rest.map(esc).join('</code> <code>') + '</code><br>Ret dem i teksten før du sender.</div>'
                : '';
        }

        /* ── Booking-link (M11) ─────────────────────────────── */
        async function _toggleBookingPopover() {
            const pop = $('pop');
            if (!pop) return;
            if (pop.classList.contains('open')) { _closeBookingPopover(); return; }

            if (!_meetingTypesCache) {
                try {
                    const r = await fetchBookingMeetingTypesIntent();
                    _meetingTypesCache = r.meeting_types || [];
                } catch (err) {
                    console.error('[mail_compose] kunne ikke hente mødetyper:', err);
                    _meetingTypesCache = [];
                }
            }
            const sel = $('intent');
            if (sel) {
                sel.innerHTML = '<option value="">— ingen forvalgt —</option>' +
                    _meetingTypesCache.map(mt =>
                        '<option value="' + attr(mt.key) + '">' + esc((mt.emoji || '') + ' ' + mt.label) +
                        ' (' + mt.duration_min + ' min)' + (mt.is_bookable ? '' : ' — sælger-only') + '</option>').join('');
                sel.value = st.bookingIntent || '';
            }
            // Kontaktformularen har ingen kalender → ingen mødetype at forvælge.
            const syncIntent = () => {
                const flow = st.el.querySelector('input[name="' + id('flow') + '"]:checked')?.value || 'smagning';
                $('intentrow').style.display = (flow === 'smagning') ? '' : 'none';
            };
            st.el.querySelectorAll('input[name="' + id('flow') + '"]').forEach(r => {
                r.checked = (r.value === st.bookingFlow);
                r.onchange = syncIntent;
            });
            syncIntent();
            pop.classList.add('open');
        }

        function _closeBookingPopover() { $('pop')?.classList.remove('open'); }

        function _insertBookingLink() {
            const flow = st.el.querySelector('input[name="' + id('flow') + '"]:checked')?.value || 'smagning';
            st.bookingFlow = flow;
            st.bookingIntent = $('intent')?.value || null;

            const ta = $('body');
            if (ta) {
                const start = ta.selectionStart ?? ta.value.length;
                const end = ta.selectionEnd ?? ta.value.length;
                ta.value = ta.value.slice(0, start) + BOOKING_TOKEN + ta.value.slice(end);
                ta.focus();
                ta.setSelectionRange(start + BOOKING_TOKEN.length, start + BOOKING_TOKEN.length);
            }
            const info = $('bookinginfo');
            if (info) {
                const flowLabel = flow === 'kontakt' ? 'Kontakt' : 'Smagsprøve';
                const intentLabel = st.bookingIntent
                    ? (_meetingTypesCache?.find(mt => mt.key === st.bookingIntent)?.label || st.bookingIntent)
                    : null;
                info.textContent = '🔗 ' + flowLabel + (intentLabel ? ' · ' + intentLabel : '');
            }
            _closeBookingPopover();
        }

        /* ── Vedhæftninger ──────────────────────────────────── */
        function _attachFile() {
            if (st.attachments.length >= MAX_ATTACHMENTS) { alert('Max ' + MAX_ATTACHMENTS + ' vedhæftninger per mail'); return; }
            $('file').click();
        }

        async function _onFileSelected(e) {
            const input = e.target;
            const file = input.files[0];
            if (!file) return;
            input.value = '';
            if (file.size > MAX_BYTES) { alert('Fil er for stor (max 10 MB)'); return; }
            const btn = $('attach');
            btn.disabled = true; btn.textContent = 'Uploader…';
            try {
                st.attachments.push(await uploadAttachment(file, 'customer', opts.customerId));
                _renderAttPills();
            } catch (err) {
                alert('Upload fejl: ' + err.message);
            } finally {
                btn.disabled = false; btn.textContent = '📎 Vedhæft';
            }
        }

        function _renderAttPills() {
            const el = $('atts');
            if (!el) return;
            el.innerHTML = st.attachments.map((a, i) =>
                '<span class="mc-pill">📎 ' + esc(a.filename || 'fil') + ' (' +
                Math.round((a.size_bytes || 0) / 1024) + ' KB)' +
                '<span class="mc-pill-x" data-mc-rmatt="' + i + '">✕</span></span>').join('');
            el.querySelectorAll('[data-mc-rmatt]').forEach(x => x.addEventListener('click', () => {
                st.attachments.splice(parseInt(x.dataset.mcRmatt, 10), 1);
                _renderAttPills();
            }));
        }

        /* ── Afsendelse ─────────────────────────────────────── */
        async function _send() {
            if (st.sending) return;
            const to = $('to').value.trim();
            const subject = $('subject').value.trim();
            const text = $('body').value.trim();
            if (!to) { alert('Skriv en modtager'); $('to').focus(); return; }
            if (!subject) { alert('Skriv et emne'); $('subject').focus(); return; }
            if (!text) { alert('Skriv en besked'); $('body').focus(); return; }

            // Sidste stop før kunden ser {{leveringsDato}} i sin indbakke.
            const unresolved = unresolvedVars(subject + '\n' + text);
            if (unresolved.length && !confirm(
                'Mailen indeholder ' + unresolved.length + ' uudfyldt' + (unresolved.length === 1 ? '' : 'e') +
                ' pladsholder' + (unresolved.length === 1 ? '' : 'e') + ':\n\n' + unresolved.join('  ') +
                '\n\nKunden vil se dem som de står. Send alligevel?')) return;

            const data = { to, subject, text };
            if (st.attachments.length) data.attachments = st.attachments.map(a => ({ attachment_id: a.attachment_id }));
            if (text.includes(BOOKING_TOKEN) || subject.includes(BOOKING_TOKEN)) {
                data.booking_flow = st.bookingFlow;
                if (st.bookingIntent) data.booking_intent_meeting_type = st.bookingIntent;
            }
            // Kontekst → hvor mailen tæller med (bon, ringeliste-formål, kampagne)
            if (opts.bonId) data.bon_id = opts.bonId;
            if (opts.purposeKey) data.purpose_key = opts.purposeKey;
            if (opts.campaignId) data.campaign_id = opts.campaignId;

            const btn = $('send');
            st.sending = true; btn.disabled = true; btn.textContent = 'Sender…';
            try {
                const res = await sendCustomerMail(opts.customerId, data);
                st.attachments = [];
                st.bookingFlow = 'smagning';
                st.bookingIntent = null;
                // Aktiviteten er sporet, ikke selve handlingen: fejler den, er mailen
                // stadig afsendt. Sig det frem for at lade kvitteringen se hel ud.
                if (res && res.activity_logged === false) {
                    alert('Mailen er sendt, men den blev ikke skrevet i kundens historik.\n' +
                          'Noter det manuelt — ellers ser kunden ud til ikke at være kontaktet.');
                }
                // Modtageren følger med, så kaldestedet kan kvittere "Mail sendt til …".
                if (typeof opts.onSent === 'function') opts.onSent(Object.assign({ to }, res));
            } catch (err) {
                alert('Kunne ikke sende: ' + (err.message || 'ukendt fejl'));
            } finally {
                st.sending = false;
                if ($('send')) { btn.disabled = false; btn.textContent = 'Send mail'; }
            }
        }

        const api = { render, destroy, uid };
        return api;
    }

    /** {{variabler}} der ikke blev udfyldt. {{booking_link}} tæller ikke — serveren løser den. */
    function unresolvedVars(text) {
        const found = (text || '').match(/\{\{[a-zA-Z0-9_]+\}\}/g) || [];
        return [...new Set(found)].filter(v => v !== BOOKING_TOKEN);
    }

    /** Samme formular i en modal. Returnerer et objekt med .close(). */
    function open(opts) {
        ensureStyles();
        const overlay = document.createElement('div');
        overlay.className = 'mc-overlay';
        const sub = opts.subtitle ? '<span class="mc-sub">' + esc(opts.subtitle) + '</span>' : '';
        overlay.innerHTML = `
            <div class="mc-modal" role="dialog" aria-modal="true">
                <div class="mc-modal-head">
                    <span>${esc(opts.title || 'Send mail')}</span>${sub}
                    <button type="button" class="mc-modal-x" aria-label="Luk">✕</button>
                </div>
                <div class="mc-modal-body"></div>
            </div>`;
        document.body.appendChild(overlay);

        const panel = overlay.querySelector('.mc-modal');
        const inst = create(Object.assign({}, opts, {
            onSent: (res) => { close(); if (typeof opts.onSent === 'function') opts.onSent(res); },
        }));
        inst.render(overlay.querySelector('.mc-modal-body'));

        function close() {
            document.removeEventListener('keydown', onKey);
            inst.destroy();
            overlay.remove();
        }
        function onKey(e) { if (e.key === 'Escape') close(); }
        overlay.querySelector('.mc-modal-x').addEventListener('click', close);
        document.addEventListener('keydown', onKey);
        // Et klik der kun rydder en tekstmarkering må ikke også lukke formularen
        // (se shared/utils.js) — derfor closeOnOutsideClick frem for e.target-tjek.
        if (typeof closeOnOutsideClick === 'function') closeOnOutsideClick(overlay, close, panel);

        setTimeout(() => overlay.querySelector('.mc-body')?.focus(), 30);
        return { close };
    }

    window.MailCompose = { create, open, unresolvedVars };
})();
