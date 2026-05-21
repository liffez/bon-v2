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
     })
     MailThread.fmtDate(iso)        // ét fælles datoformat
     MailThread.normalize(opts)     // tråde/beskeder → sorteret flad liste
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

    window.MailThread = {
        renderHistory: renderHistory,
        fmtDate: fmtDate,
        normalize: normalize,
        esc: esc,
    };
})();
