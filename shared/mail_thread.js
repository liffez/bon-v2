/* ══════════════════════════════════════════════════════════════
   mail_thread.js — fælles mail-historik komponent
   ══════════════════════════════════════════════════════════════
   Én visning af mail-korrespondance på tværs af hele systemet:
   bon-kort, bon-drawer, info-modal, leverandørpost, indkøb og CRM.

   Erstatter de tidligere fire separate chat-boble-implementeringer
   (bm-msg / si-msg / ib-po-msg / k3-mail-msg).

   Nøglefunktion: hver besked vises afkortet men kan foldes ud til
   FULD tekst med ét klik — tidligere kunne man aldrig læse hele
   beskeden.

   API:
     MailThread.renderHistory(container, {
       threads | messages,   // rå mail-data (tråde ELLER flad liste)
       header,               // valgfri overskrift — viser ulæst-tæller
       emptyText,            // tekst når der ingen mails er
       maxHeight,            // valgfri scroll-højde på listen (px-tal/streng)
       onMarkRead,           // valgfri (msgId) => Promise — markér læst
       expandUnread,         // valgfri bool — fold ulæste indgående ud straks
     })
     MailThread.fmtDate(iso)        // ét fælles datoformat
     MailThread.normalize(opts)     // tråde/beskeder → sorteret flad liste
     MailThread.buildVars(bon)      // skabelon-variabler fra en bon ({{kundeNavn}}…)
     MailThread.renderSignatureHint(container)  // "signaturen tilføjes automatisk"
   ══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /* Ét fælles datoformat. dd/M HH:MM — med 2-cifret år hvis ikke i år. */
    function fmtDate(iso) {
        if (!iso) return '';
        var d = (typeof parseServerDate === 'function') ? parseServerDate(iso) : new Date(iso);
        if (!d || isNaN(d.getTime())) return '';
        var p = function (n) { return String(n).padStart(2, '0'); };
        var sameYear = d.getFullYear() === new Date().getFullYear();
        var datePart = d.getDate() + '/' + (d.getMonth() + 1)
            + (sameYear ? '' : '/' + String(d.getFullYear()).slice(2));
        return datePart + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    /* Tråde eller flad liste → ét sorteret array (nyeste først). */
    function normalize(opts) {
        var msgs = [];
        if (Array.isArray(opts.messages)) {
            msgs = opts.messages.slice();
        } else if (Array.isArray(opts.threads)) {
            opts.threads.forEach(function (t) {
                (t.messages || []).forEach(function (m) {
                    var mm = Object.assign({}, m);
                    if (mm._threadSubject == null) mm._threadSubject = t.subject;
                    msgs.push(mm);
                });
            });
        }
        msgs.sort(function (a, b) {
            var ta = a.received_at || a.sent_at || a.created_at || '';
            var tb = b.received_at || b.sent_at || b.created_at || '';
            return String(tb).localeCompare(String(ta));
        });
        return msgs;
    }

    /* En besked er "lang" hvis den ikke kan ses i kollapset højde.
       Heuristik på tegn/linjer — virker også når containeren er skjult
       (scrollHeight kan ikke måles på display:none). */
    function isLongBody(body) {
        if (!body) return false;
        var newlines = (body.match(/\n/g) || []).length;
        return body.length > 260 || newlines > 5;
    }

    /* Har beskeden en HTML-krop vi skal rendere (frem for ren tekst)? */
    function hasHtmlBody(m) {
        return !!(m && m.body_html && String(m.body_html).trim());
    }

    function attachmentsHtml(atts, hideInline) {
        var ok = (atts || []).filter(function (a) {
            if (!a || !a.id) return false;
            // Inline billeder vises inde i HTML-kroppen — ikke som 📎-link.
            if (hideInline && a.is_inline) return false;
            return true;
        });
        if (!ok.length) return '';
        return '<div class="mt-msg-atts">' + ok.map(function (a) {
            var kb = Math.round((a.size_bytes || 0) / 1024);
            var url = (typeof mailAttachmentUrl === 'function') ? mailAttachmentUrl(a.id) : '#';
            return '<a class="mt-msg-att" target="_blank" rel="noopener" href="' + esc(url) + '">'
                + '📎 ' + esc(a.filename || 'fil') + (kb ? ' (' + kb + ' KB)' : '') + '</a>';
        }).join('') + '</div>';
    }

    /* Byg et komplet, isoleret HTML-dokument til en mail-krop.
       Renderes i en sandboxed iframe uden allow-scripts — afsenderens JS kan
       aldrig køre. cid:-billeder peges om til vores inline-endpoint, og en
       CSP begrænser hvilke ressourcer der overhovedet må hentes. */
    function buildMailDoc(m) {
        var html = String(m.body_html || '');
        // Fjern scripts/base defensivt (sandbox blokerer også scripts).
        html = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<base\b[^>]*>/gi, '');

        // cid:CONTENT_ID → inline-URL for den gemte vedhæftning.
        (m.attachments || []).forEach(function (a) {
            if (!a || !a.content_id || a.id == null) return;
            if (typeof mailInlineUrl !== 'function') return;
            var cid = String(a.content_id).replace(/^<|>$/g, '');
            var reCid = cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            var re = new RegExp('cid:' + reCid, 'gi');
            html = html.replace(re, mailInlineUrl(a.id));
        });

        var csp = "default-src 'none'; img-src 'self' data: https: http:; "
            + "style-src 'unsafe-inline'; font-src data: https: http:; "
            + "media-src 'none'; frame-src 'none'; object-src 'none'; "
            + "base-uri 'none'; form-action 'none';";

        return '<!doctype html><html><head><meta charset="utf-8">'
            + '<meta http-equiv="Content-Security-Policy" content="' + csp + '">'
            + '<meta name="referrer" content="no-referrer">'
            + '<base target="_blank">'
            + '<style>html,body{margin:0;padding:0;background:#fff;}'
            + 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;'
            + 'font-size:13px;line-height:1.5;color:#1a1917;padding:10px 12px;word-break:break-word;overflow-wrap:anywhere;}'
            + 'img{max-width:100%;height:auto;}table{max-width:100%;}*{max-width:100%;box-sizing:border-box;}'
            + 'a{color:#8e631f;}</style>'
            + '</head><body>' + html + '</body></html>';
    }

    function msgHtml(m, idx) {
        var isIn = m.direction === 'in';
        var isUnread = isIn && !m.is_read;
        var who = isIn ? (m.from_name || m.from_email || 'Ukendt') : 'Ristet Rug';
        var when = fmtDate(m.received_at || m.sent_at || m.created_at);
        var subject = m.subject || m._threadSubject || '';
        var bonTag = m.bon_number ? ' · #' + esc(m.bon_number) : '';
        var isHtml = hasHtmlBody(m);
        var body = (m.body_text || '').replace(/\r\n/g, '\n').trim();
        var long = !isHtml && isLongBody(body); // tekst-kollaps; HTML kollapses efter måling

        // En udgående besked UDEN sent_at forlod aldrig huset (#362). Tidligere
        // blev sent_at sat allerede ved oprettelsen, så en fejlet mail så
        // fuldstændig ud som en sendt — også for et menneske der læste tråden.
        // `send_error` findes kun på nyere rækker; fravær af sent_at er det
        // bærende signal, så gamle rækker ikke pludselig markeres som fejlede.
        // Kun dømme når endpointet faktisk har fortalt os om sent_at — ellers
        // ville en visning der ikke henter feltet markere alt som fejlet.
        var knowsSentAt = Object.prototype.hasOwnProperty.call(m, 'sent_at');
        var failed = !isIn && knowsSentAt && !m.sent_at;

        var h = '<div class="mt-msg ' + (isIn ? 'mt-in' : 'mt-out')
            + (isUnread ? ' mt-unread' : '') + (long ? ' mt-collapsible' : '')
            + (isHtml ? ' mt-html' : '') + (failed ? ' mt-failed' : '')
            + '" data-mt-idx="' + idx + '">';
        h += '<div class="mt-msg-head">'
            + '<span class="mt-msg-from">' + esc(who) + bonTag + '</span>'
            + '<span class="mt-msg-date">' + esc(when)
            + (isUnread ? ' <span class="mt-msg-new">Ny</span>' : '')
            + '</span>'
            + '</div>';
        if (failed) {
            h += '<div class="mt-msg-failed" title="' + esc(m.send_error || '') + '">'
                + '⚠ Ikke sendt' + (m.send_error ? ' — ' + esc(String(m.send_error).slice(0, 120)) : '')
                + '</div>';
        }
        if (subject) h += '<div class="mt-msg-subject">' + esc(subject) + '</div>';
        if (isHtml) {
            // iframen indsættes af renderHistory (srcdoc kan ikke stå i en HTML-streng).
            h += '<div class="mt-msg-html" data-mt-html="' + idx + '">'
                + '<div class="mt-html-loading">Indlæser mail…</div></div>';
        } else {
            h += '<div class="mt-msg-body">' + (body ? esc(body) : '<span class="mt-msg-nobody">(ingen tekst)</span>') + '</div>';
            if (long) h += '<button type="button" class="mt-msg-more"></button>';
        }
        h += attachmentsHtml(m.attachments, isHtml);
        h += '</div>';
        return h;
    }

    /* ── Iframe-størrelse + kollaps for HTML-mails ─────────────── */
    var HTML_COLLAPSE_PX = 460;

    function sizeFrame(iframe) {
        try {
            var d = iframe.contentDocument;
            if (!d || !d.body) return;
            var h = Math.max(d.documentElement.scrollHeight, d.body.scrollHeight);
            if (h) iframe.style.height = (h + 6) + 'px';
        } catch (e) { /* opak origin — bør ikke ske med allow-same-origin */ }
    }

    function applyCollapse(host, iframe) {
        if (host._mtExpanded || host._mtCollapseSet) return;
        var fh = parseInt(iframe.style.height, 10) || 0;
        if (fh <= HTML_COLLAPSE_PX) return;
        host._mtCollapseSet = true;
        host.classList.add('mt-html-collapsed');
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mt-msg-more mt-html-more';
        btn.textContent = 'Vis hele mailen ▾';
        btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            host._mtExpanded = true;
            host.classList.remove('mt-html-collapsed');
            btn.remove();
        });
        host.parentNode.insertBefore(btn, host.nextSibling);
    }

    function wireFrame(iframe, host) {
        sizeFrame(iframe);
        applyCollapse(host, iframe);
        try {
            var imgs = iframe.contentDocument.images;
            for (var i = 0; i < imgs.length; i++) {
                imgs[i].addEventListener('load', function () { sizeFrame(iframe); applyCollapse(host, iframe); });
                imgs[i].addEventListener('error', function () { sizeFrame(iframe); });
            }
        } catch (e) { /* ignore */ }
        // Re-mål efterhånden som billeder/fonte lander.
        [150, 500, 1200].forEach(function (t) {
            setTimeout(function () { sizeFrame(iframe); applyCollapse(host, iframe); }, t);
        });
    }

    function mountHtmlFrames(container, msgs) {
        container.querySelectorAll('.mt-msg-html[data-mt-html]').forEach(function (host) {
            var m = msgs[parseInt(host.getAttribute('data-mt-html'), 10)];
            if (!m) return;
            var iframe = document.createElement('iframe');
            iframe.className = 'mt-html-frame';
            iframe.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
            iframe.setAttribute('referrerpolicy', 'no-referrer');
            iframe.setAttribute('scrolling', 'no');
            iframe.title = 'Mail-indhold';
            iframe.addEventListener('load', function () { wireFrame(iframe, host); });
            host.innerHTML = '';
            host.appendChild(iframe);
            iframe.srcdoc = buildMailDoc(m);

            // Hvis containeren er skjult ved montering (fx kollapset drawer-sektion)
            // måler iframen til 0 — re-mål når den bliver synlig igen.
            if (window.ResizeObserver) {
                try {
                    var ro = new ResizeObserver(function () { sizeFrame(iframe); applyCollapse(host, iframe); });
                    ro.observe(host);
                } catch (e) { /* ignore */ }
            }
        });
    }

    /* Render ÉN mail-krop (uden chat-boble/afsender-header) ind i en container.
       HTML-mails vises i sandboxed iframe med inline CID-billeder; ren-tekst
       vises escaped. Bruges af CRM-indbakken hvor afsender/emne vises separat. */
    function renderBody(container, m) {
        if (!container) return;
        m = m || {};
        if (hasHtmlBody(m)) {
            container.innerHTML = '<div class="mt-msg mt-html mt-standalone">'
                + '<div class="mt-msg-html" data-mt-html="0">'
                + '<div class="mt-html-loading">Indlæser mail…</div></div></div>';
            mountHtmlFrames(container, [m]);
        } else {
            var body = (m.body_text || '').replace(/\r\n/g, '\n').trim();
            container.innerHTML = '<div class="mt-msg-body mt-standalone-body">'
                + (body ? esc(body) : '<span class="mt-msg-nobody">(ingen tekst)</span>')
                + '</div>';
        }
    }

    /* Render mail-historik ind i container. */
    function renderHistory(container, opts) {
        if (!container) return;
        opts = opts || {};
        var msgs = normalize(opts);

        var html = '';

        if (opts.header) {
            // header er betroet HTML — kun litteraler fra kalderne (fx mailIcon()).
            var unread = msgs.filter(function (m) { return m.direction === 'in' && !m.is_read; }).length;
            html += '<div class="mt-head">' + opts.header
                + (unread ? ' <span class="mt-head-count">' + unread + ' ulæst</span>' : '')
                + '</div>';
        }

        if (!msgs.length) {
            html += '<div class="mt-empty">' + esc(opts.emptyText || 'Ingen korrespondance endnu') + '</div>';
            container.innerHTML = html;
            return;
        }

        var listStyle = '';
        if (opts.maxHeight) {
            var mh = (typeof opts.maxHeight === 'number') ? opts.maxHeight + 'px' : opts.maxHeight;
            listStyle = ' style="max-height:' + esc(mh) + ';overflow-y:auto"';
        }
        html += '<div class="mt-thread"' + listStyle + '>'
            + msgs.map(msgHtml).join('') + '</div>';
        container.innerHTML = html;

        // HTML-mails: indsæt sandboxed iframes (kan ikke stå i innerHTML-strengen).
        mountHtmlFrames(container, msgs);

        // Interaktion: klik på boble → fold ud/ind + markér læst.
        container.querySelectorAll('.mt-msg').forEach(function (el) {
            var m = msgs[parseInt(el.dataset.mtIdx, 10)];
            // Fold ulæste indgående beskeder ud straks, så man kan læse hele
            // mailen OG se resten af flowet samtidig (uden at markere læst).
            if (opts.expandUnread && m && m.direction === 'in' && !m.is_read
                && el.classList.contains('mt-collapsible')) {
                el.classList.add('mt-expanded');
            }
            el.addEventListener('click', function (ev) {
                if (ev.target.closest('.mt-msg-att')) return; // lad links virke
                if (el.classList.contains('mt-collapsible')) {
                    el.classList.toggle('mt-expanded');
                }
                if (el.classList.contains('mt-unread') && opts.onMarkRead && m && m.id != null) {
                    el.classList.remove('mt-unread');
                    var badge = el.querySelector('.mt-msg-new');
                    if (badge) badge.remove();
                    Promise.resolve(opts.onMarkRead(m.id)).catch(function (e) {
                        console.warn('[mail] markér læst fejl:', e && e.message);
                    });
                }
            });
        });
    }

    /* Byg skabelon-variabler ({{kundeNavn}}, {{menuMedPriser}} …) fra en bon.
       Kanonisk kilde — bruges på mobil; office har historisk egne kopier i
       bon_kort.js/bon_drawer.js. Moms via window.Moms (aldrig magic-faktorer);
       hvis Moms ikke er loadet udelades pris-felterne i stedet for at gætte. */
    function buildVars(bon) {
        bon = bon || {};
        // Ens linjer slås sammen — se shared/bon_lines.js. Uden det får kunden
        // "1× Kartoflen slider" tre gange i stedet for "3×".
        var lines = BonLines.mergeLines(bon.lines || []);
        var groups = bon.menu_groups || [];
        var menuLines = lines.filter(function (l) {
            var c = (l.category || '').toLowerCase();
            return c !== 'emballage' && c !== 'levering';
        });

        var groupById = new Map(groups.map(function (g) { return [g.id, g]; }));
        var groupOrder = [];
        var linesByGroup = new Map();
        var ungrouped = [];
        menuLines.forEach(function (l) {
            var gid = l.menu_group_id;
            if (gid && groupById.has(gid)) {
                if (!linesByGroup.has(gid)) { linesByGroup.set(gid, []); groupOrder.push(gid); }
                linesByGroup.get(gid).push(l);
            } else {
                ungrouped.push(l);
            }
        });
        groupOrder.sort(function (a, b) {
            return (groupById.get(a).sort_order || 0) - (groupById.get(b).sort_order || 0);
        });

        var _norm = function (s) { return String(s || '').trim().toLowerCase(); };
        var _renderLine = function (l, group, withPrice) {
            var comment = (l.special_request || '').trim();
            if (comment && group) {
                var n = _norm(comment);
                if (n === _norm(group.title) || n === _norm(group.note)) comment = '';
            }
            var commentPart = comment ? ' (' + comment + ')' : '';
            var pricePart = (withPrice && l.unit_price)
                ? '  ' + (l.quantity * l.unit_price).toLocaleString('da-DK') + ' kr' : '';
            return l.quantity + '× ' + l.product_name + commentPart + pricePart;
        };
        var _buildMenu = function (withPrice) {
            var parts = [];
            groupOrder.forEach(function (gid) {
                var g = groupById.get(gid);
                var header = (g.title || g.note || '').trim();
                if (header) parts.push(header + ':');
                linesByGroup.get(gid).forEach(function (l) {
                    parts.push((header ? '  ' : '') + _renderLine(l, g, withPrice));
                });
                parts.push('');
            });
            ungrouped.forEach(function (l) { parts.push(_renderLine(l, null, withPrice)); });
            while (parts.length && parts[parts.length - 1] === '') parts.pop();
            return parts.join('\n');
        };

        // line_total er incl. moms (jf. BON_V2_PRINCIPPER.md sektion 6b)
        var totalInkl = lines.reduce(function (s, l) { return s + (l.line_total || 0); }, 0);
        var hasMoms = window.Moms && typeof window.Moms.inclToExcl === 'function';
        var kr = function (n) { return n.toLocaleString('da-DK', { minimumFractionDigits: 2 }) + ' kr'; };
        var addrObj = bon.delivery_address || {};
        var addr = typeof addrObj === 'string' ? addrObj
            : [addrObj.street_name, addrObj.street_nr, addrObj.postal_code, addrObj.city].filter(Boolean).join(' ');

        var vars = {
            kundeNavn: bon.contact_name_full || bon.customer_name || bon.contact_name || '',
            bonNummer: bon.bon_number || '',
            leveringsDato: bon.delivery_date || '',
            leveringsTidspunkt: bon.delivery_time || bon.pickup_time || '',
            leveringsAdresse: addr,
            postnummer: (typeof addrObj === 'object' && addrObj.postal_code) ? String(addrObj.postal_code) : '',
            telefon: bon.contact_phone || bon.customer_phone || '',
            pax: String(bon.pax || ''),
            firmanavn: bon.company_name || '',
            menuUdenPriser: _buildMenu(false),
            menuMedPriser: _buildMenu(true),
            co2PerLinje: menuLines.filter(function (l) { return l.co2e; }).map(function (l) {
                return l.product_name + ': ' + l.co2e + ' kg × ' + l.quantity + ' = ' + (l.co2e * l.quantity).toFixed(2);
            }).join('\n'),
            co2Total: menuLines.reduce(function (s, l) { return s + ((l.co2e || 0) * l.quantity); }, 0).toFixed(2) + ' kg CO₂e',
        };
        if (hasMoms) {
            vars.totalPris = kr(totalInkl);
            vars.totalExMoms = kr(window.Moms.inclToExcl(totalInkl));
            vars.momsBeloeb = kr(window.Moms.momsOfIncl(totalInkl));
        }
        return vars;
    }

    /* ── Signatur-varsel under skrivefelter ──────────────────────
       Serveren sætter signaturen på i sendMail(), så den er der uanset
       hvad. Uden at vise det, skriver folk deres egen hilsen i feltet og
       mailen får to. Hentes én gang pr. sideindlæsning og caches. */

    var _sigPromise = null;

    function getSignature() {
        if (!_sigPromise) {
            // /api/settings svarer med et ARRAY af {key, value, description} —
            // ikke et key→value-objekt. (Settings-siden mapper det selv.)
            _sigPromise = fetch('/api/settings', { credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.json() : []; })
                .then(function (rows) {
                    if (Array.isArray(rows)) {
                        var hit = rows.find(function (r) { return r.key === 'mail_signature'; });
                        return (hit && hit.value) || '';
                    }
                    return (rows && rows.mail_signature) || '';
                })
                .catch(function () { return ''; });
        }
        return _sigPromise;
    }

    function renderSignatureHint(container) {
        if (!container) return;
        getSignature().then(function (sig) {
            if (!sig) return;   // ingen signatur sat — intet at love
            container.innerHTML =
                '<div class="mt-sig-hint">' +
                    '<button type="button" class="mt-sig-toggle">' +
                        'Signaturen tilføjes automatisk <span class="mt-sig-caret">▾</span>' +
                    '</button>' +
                    '<pre class="mt-sig-body">' + esc(sig) + '</pre>' +
                '</div>';
            var box = container.querySelector('.mt-sig-hint');
            container.querySelector('.mt-sig-toggle').addEventListener('click', function () {
                box.classList.toggle('open');
            });
        });
    }

    window.MailThread = {
        renderHistory: renderHistory,
        renderSignatureHint: renderSignatureHint,
        getSignature: getSignature,
        renderBody: renderBody,
        fmtDate: fmtDate,
        normalize: normalize,
        buildVars: buildVars,
        esc: esc,
    };
})();
