/**
 * shared/crm_contact_context.js — "hvem ringer jeg til?" ét sted
 * ================================================================
 * Kontekstlinjen (stemning · aktiviteter · afstand) og historikken bag
 * "▼ historik" til alle lister man ringer fra: service-kald, ringelisten
 * (CrmWorklist) og kampagne-tavlen. Tallene kommer fra serveren
 * (services/crmContactContext.js) — denne fil renderer dem kun.
 *
 * Samme kode alle steder: skrevet pr. liste ville de tre drive fra hinanden,
 * præcis som _buildMailVars gjorde.
 *
 *   CrmContactContext.lineHtml(row, { compact })  → HTML-streng
 *   CrmContactContext.historyButtonHtml(attrs)    → "▼ historik"-knap
 *   CrmContactContext.toggleHistory(el, customerId) → fold ud/ind + hent
 *
 * Kræver shared/api.js (fetchCrmCustomerActivities, fetchCrmCustomerOrders)
 * og shared/utils.js (escapeHtml, parseServerDate).
 */
(function () {
    'use strict';

    const SENT = {
        positive: { emoji: '😊', label: 'God' },
        neutral:  { emoji: '😐', label: 'Neutral' },
        negative: { emoji: '😟', label: 'Dårlig' },
    };
    const ACT_LABEL = {
        call: 'opkald', service_call: 'service-kald', meeting: 'møde', task: 'opgave',
        note: 'note', followup: 'opfølgning', offer_sent: 'tilbud sendt',
        email_in: 'mail ind', email_out: 'mail ud',
    };
    const RESULT_LABEL = {
        reached: 'nået', no_answer: 'intet svar', busy: 'optaget', voicemail: 'besked',
        callback: 'ring tilbage', email_instead: 'mail i stedet',
    };

    function esc(s) {
        return (typeof escapeHtml === 'function') ? escapeHtml(s)
            : String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    // Serverens tidsstempler er UTC uden markør — parseServerDate tolker dem rigtigt.
    function shortDate(s) {
        if (!s) return '';
        const d = (typeof parseServerDate === 'function') ? parseServerDate(s) : new Date(s);
        if (!d || isNaN(d)) return '';
        const sameYear = d.getFullYear() === new Date().getFullYear();
        return d.getDate() + '/' + (d.getMonth() + 1) + (sameYear ? '' : '-' + String(d.getFullYear()).slice(2));
    }

    function fmtKm(km) {
        return (km < 10 ? km.toFixed(1) : String(Math.round(km))).replace('.', ',') + ' km';
    }

    let _styled = false;
    function ensureStyles() {
        if (_styled) return;
        _styled = true;
        const st = document.createElement('style');
        st.textContent = `
            .cc-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px;
                margin-top: 5px; font-size: 11.5px; color: var(--color-text-dim, #777); }
            .cc-line.compact { gap: 3px 6px; font-size: 11px; margin-top: 4px; }
            .cc-dim { opacity: .75; font-style: italic; }
            .cc-chip { display: inline-flex; align-items: center; gap: 3px; padding: 1px 8px;
                border-radius: 10px; font-size: 11.5px; font-weight: 600;
                border: 1px solid transparent; white-space: nowrap; color: #333; }
            .cc-line.compact .cc-chip { padding: 0 6px; font-size: 11px; }
            .cc-chip.s-positive { background: var(--color-sentiment-pos-bg, #E6F7F0); border-color: var(--color-sentiment-pos, #2E9E6B); }
            .cc-chip.s-neutral  { background: var(--color-sentiment-neu-bg, #FBF3E2); border-color: var(--color-sentiment-neu, #C8962A); }
            .cc-chip.s-negative { background: var(--color-sentiment-neg-bg, #FBE9E9); border-color: var(--color-sentiment-neg, #C94040); }
            .cc-chip.colleague { border-style: dashed; font-weight: 500; }
            .cc-hist-btn { background: none; border: 0; padding: 0; cursor: pointer; font: inherit;
                font-size: 11px; color: var(--color-text-dim, #888); white-space: nowrap; }
            .cc-hist-btn:hover { color: var(--brand-primary, #8e631f); }
            .cc-hist { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--color-border, #eee); text-align: left; }
            .cc-hist-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px;
                color: var(--color-text-dim, #888); margin-bottom: 4px; }
            .cc-hist-empty { font-size: 12px; color: var(--color-text-dim, #888); }
            .cc-act { font-size: 12px; padding: 4px 0 4px 10px; border-left: 2px solid var(--color-border, #e6e1da); margin-bottom: 4px; }
            .cc-act.planned { border-left-style: dashed; opacity: .85; }
            .cc-act-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
            .cc-act-date { font-weight: 700; color: var(--brand-primary, #8e631f); }
            .cc-act-type { font-weight: 600; }
            .cc-act-dim { color: var(--color-text-dim, #888); }
            .cc-act-text { color: #555; margin-top: 2px; white-space: pre-wrap; }
            .cc-order { margin-bottom: 8px; font-size: 12px; }
            .cc-order-head { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
            .cc-order-bon { font-family: monospace; font-weight: 700; color: var(--brand-primary, #8e631f); }
            .cc-order-lines { padding-left: 12px; border-left: 2px solid var(--brand-primary-light, #f1e6b2); }
            .cc-order-line { padding: 1px 0; color: #555; }
            .cc-order-qty { color: var(--brand-primary, #8e631f); font-weight: 700; }
            .cc-order-extra { color: var(--color-text-dim, #aaa); font-style: italic; }
        `;
        document.head.appendChild(st);
    }

    function sentimentChip(r, compact) {
        const own = SENT[r.last_sentiment];
        if (own) {
            return '<span class="cc-chip s-' + r.last_sentiment + '" title="Seneste stemning hos kunden' +
                (r.last_sentiment_at ? ' (' + shortDate(r.last_sentiment_at) + ')' : '') + '">' +
                own.emoji + (compact ? '' : ' ' + own.label) +
                (r.last_sentiment_at ? ' · ' + shortDate(r.last_sentiment_at) : '') + '</span>';
        }
        const col = SENT[r.colleague_sentiment];
        if (col) {
            // Kollegaens stemning — altid med navn, så man ikke tror det var kunden selv.
            const who = r.colleague_sentiment_by || 'en kollega';
            return '<span class="cc-chip s-' + r.colleague_sentiment + ' colleague" title="' +
                esc('Kunden har ingen stemning registreret — ' + who + ' på samme firma' +
                    (r.colleague_sentiment_at ? ', ' + shortDate(r.colleague_sentiment_at) : '')) + '">' +
                col.emoji + (compact ? '' : ' ' + col.label + ' · ' + esc(who) +
                    (r.colleague_sentiment_at ? ', ' + shortDate(r.colleague_sentiment_at) : '')) + '</span>';
        }
        return '';
    }

    function distanceHtml(r, compact) {
        if (r.distance_km != null) {
            const where = [r.delivery_postal_code, r.delivery_city].filter(Boolean).join(' ');
            const tip = (r.distance_estimated
                ? 'Skønnet: luftlinje fra HQ × vejfaktor — ruten er ikke beregnet'
                : 'Vejafstand fra HQ') + (where ? ' · ' + where : '');
            return '<span title="' + esc(tip) + '">🚗 ' + (r.distance_estimated ? 'ca. ' : '') + fmtKm(r.distance_km) +
                (!compact && where ? ' · ' + esc(where) : '') + '</span>';
        }
        if (r.distance_is_pickup || r.delivery_type === 'pickup' || r.delivery_method === 'pickup') {
            return '<span class="cc-dim">🏠 Afhentning</span>';
        }
        return '';
    }

    // Linjen under navnet. compact: til små kort (kampagne-tavlen) — kun emoji,
    // antal og km; resten står i tooltips.
    function lineHtml(r, opts) {
        ensureStyles();
        const compact = !!(opts && opts.compact);
        const parts = [];
        const chip = sentimentChip(r, compact);
        if (chip) parts.push(chip);
        if (r.activity_count) {
            const lastTxt = r.last_contact_at
                ? (ACT_LABEL[r.last_contact_type] || 'kontakt') + ' ' + shortDate(r.last_contact_at) : '';
            parts.push(compact
                ? '<span title="' + esc(r.activity_count + ' aktiviteter' + (lastTxt ? ' · sidst ' + lastTxt : '')) + '">💬 ' + r.activity_count + '</span>'
                : '<span>' + r.activity_count + ' aktivitet' + (r.activity_count === 1 ? '' : 'er') +
                    (lastTxt ? ' · sidst ' + lastTxt : '') + '</span>');
        } else if (!compact) {
            parts.push('<span class="cc-dim">Ingen tidligere kontakt' +
                (r.colleague_activity_count ? ' · ' + r.colleague_activity_count + ' med kolleger' : '') + '</span>');
        }
        const dist = distanceHtml(r, compact);
        if (dist) parts.push(dist);
        if (!parts.length) return '';
        return '<div class="cc-line' + (compact ? ' compact' : '') + '">' + parts.join('') + '</div>';
    }

    function historyButtonHtml(attrs) {
        ensureStyles();
        return '<button type="button" class="cc-hist-btn" title="Tidligere aktiviteter og ordrer"' +
            (attrs ? ' ' + attrs : '') + '>▼ historik</button>';
    }

    function activitiesHtml(acts) {
        if (!acts.length) return '<div class="cc-hist-empty">Ingen aktiviteter endnu</div>';
        return acts.map(a => {
            const sent = SENT[a.sentiment];
            const when = a.is_planned ? a.due_at : (a.done_at || a.created_at);
            const head = [
                '<span class="cc-act-date">' + (a.is_planned ? 'planlagt ' : '') + shortDate(when) + '</span>',
                '<span class="cc-act-type">' + (a.purpose_emoji ? esc(a.purpose_emoji) + ' ' : '') +
                    esc(a.purpose_label || ACT_LABEL[a.type] || a.type) + '</span>',
                a.result ? '<span class="cc-act-dim">' + esc(RESULT_LABEL[a.result] || a.result) + '</span>' : '',
                sent ? '<span class="cc-chip s-' + a.sentiment + '">' + sent.emoji + ' ' + sent.label + '</span>' : '',
                a.is_colleague && a.customer_name ? '<span class="cc-act-dim">· ' + esc(a.customer_name) + '</span>' : '',
                a.bon_number ? '<span class="cc-act-dim">#' + esc(a.bon_number) + '</span>' : '',
                a.user_name ? '<span class="cc-act-dim" style="margin-left:auto;">' + esc(a.user_name) + '</span>' : '',
            ].join('');
            return '<div class="cc-act' + (a.is_planned ? ' planned' : '') + '">' +
                '<div class="cc-act-head">' + head + '</div>' +
                (a.text ? '<div class="cc-act-text">' + esc(a.text) + '</div>' : '') +
            '</div>';
        }).join('');
    }

    function ordersHtml(orders) {
        if (!orders.length) return '<div class="cc-hist-empty">Ingen tidligere ordrer</div>';
        return orders.map(o => {
            const statusLabel = o.status_label || o.status || '';
            return '<div class="cc-order">' +
                '<div class="cc-order-head">' +
                    '<span class="cc-order-bon">' + esc(o.bon_number || '') + '</span>' +
                    '<span class="cc-act-dim">' + esc(o.delivery_date || '') + '</span>' +
                    (o.pax ? '<span>' + o.pax + ' pax</span>' : '') +
                    '<span style="font-weight:700;margin-left:auto;">' +
                        (o.total_price ? Math.round(o.total_price).toLocaleString('da-DK') + ' kr' : '') + '</span>' +
                    (statusLabel ? '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:var(--color-background);font-weight:700;">' + esc(statusLabel) + '</span>' : '') +
                '</div>' +
                (o.lines && o.lines.length ? '<div class="cc-order-lines">' +
                    o.lines.map(l =>
                        '<div class="cc-order-line"><span class="cc-order-qty">' + esc(l.quantity) + '×</span> ' +
                            esc(l.product_name || '') +
                            (l.special_request ? ' <span class="cc-order-extra"> — ' + esc(l.special_request) + '</span>' : '') +
                        '</div>'
                    ).join('') + '</div>' : '') +
            '</div>';
        }).join('');
    }

    // Fold historikken ud i `el` (eller ind igen). Hver halvdel fejler for sig:
    // en fejl i ordrerne må ikke skjule aktiviteterne.
    async function toggleHistory(el, customerId) {
        if (!el) return;
        ensureStyles();
        if (el.dataset.ccOpen === '1') { el.dataset.ccOpen = ''; el.innerHTML = ''; el.style.display = 'none'; return; }
        el.dataset.ccOpen = '1';
        el.style.display = 'block';
        if (!customerId) {
            el.innerHTML = '<div class="cc-hist"><div class="cc-hist-empty">Ingen kontaktperson — ingen historik at vise.</div></div>';
            return;
        }
        el.innerHTML = '<div class="cc-hist"><div class="cc-hist-empty">Henter historik…</div></div>';
        const [actsRes, ordersRes] = await Promise.allSettled([
            fetchCrmCustomerActivities(customerId, 6),
            fetchCrmCustomerOrders(customerId, 5),
        ]);
        if (el.dataset.ccOpen !== '1') return;   // lukket igen mens vi hentede
        const err = (r) => '<div class="cc-hist-empty" style="color:var(--color-sentiment-neg,#c94040);">Fejl: ' +
            esc((r.reason && r.reason.message) || 'ukendt') + '</div>';
        el.innerHTML = '<div class="cc-hist">' +
            '<div class="cc-hist-label">Aktiviteter</div>' +
            (actsRes.status === 'fulfilled' ? activitiesHtml(actsRes.value || []) : err(actsRes)) +
            '<div class="cc-hist-label" style="margin-top:10px;">Ordrer</div>' +
            (ordersRes.status === 'fulfilled' ? ordersHtml(ordersRes.value || []) : err(ordersRes)) +
        '</div>';
    }

    window.CrmContactContext = { lineHtml, historyButtonHtml, toggleHistory, activitiesHtml, ordersHtml, shortDate };
})();
