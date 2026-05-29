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

    function attachmentsHtml(atts) {
        var ok = (atts || []).filter(function (a) { return a && a.id; });
        if (!ok.length) return '';
        return '<div class="mt-msg-atts">' + ok.map(function (a) {
            var kb = Math.round((a.size_bytes || 0) / 1024);
            var url = (typeof mailAttachmentUrl === 'function') ? mailAttachmentUrl(a.id) : '#';
            return '<a class="mt-msg-att" target="_blank" rel="noopener" href="' + esc(url) + '">'
                + '📎 ' + esc(a.filename || 'fil') + (kb ? ' (' + kb + ' KB)' : '') + '</a>';
        }).join('') + '</div>';
    }

    function msgHtml(m, idx) {
        var isIn = m.direction === 'in';
        var isUnread = isIn && !m.is_read;
        var who = isIn ? (m.from_name || m.from_email || 'Ukendt') : 'Ristet Rug';
        var when = fmtDate(m.received_at || m.sent_at || m.created_at);
        var subject = m.subject || m._threadSubject || '';
        var body = (m.body_text || '').replace(/\r\n/g, '\n').trim();
        var bonTag = m.bon_number ? ' · #' + esc(m.bon_number) : '';
        var long = isLongBody(body);

        var h = '<div class="mt-msg ' + (isIn ? 'mt-in' : 'mt-out')
            + (isUnread ? ' mt-unread' : '') + (long ? ' mt-collapsible' : '')
            + '" data-mt-idx="' + idx + '">';
        h += '<div class="mt-msg-head">'
            + '<span class="mt-msg-from">' + esc(who) + bonTag + '</span>'
            + '<span class="mt-msg-date">' + esc(when)
            + (isUnread ? ' <span class="mt-msg-new">Ny</span>' : '')
            + '</span>'
            + '</div>';
        if (subject) h += '<div class="mt-msg-subject">' + esc(subject) + '</div>';
        h += '<div class="mt-msg-body">' + (body ? esc(body) : '<span class="mt-msg-nobody">(ingen tekst)</span>') + '</div>';
        if (long) h += '<button type="button" class="mt-msg-more"></button>';
        h += attachmentsHtml(m.attachments);
        h += '</div>';
        return h;
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
        var lines = bon.lines || [];
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

    window.MailThread = {
        renderHistory: renderHistory,
        fmtDate: fmtDate,
        normalize: normalize,
        buildVars: buildVars,
        esc: esc,
    };
})();
