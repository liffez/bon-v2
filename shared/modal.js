/**
 * shared/modal.js
 * ════════════════════════════════════════════════════════════
 * Genbrugelig modal-komponent for Bon v2.
 *
 * API:
 *   openModal({ title, bodyHtml })  → vis modal
 *   closeModal()                    → luk modal
 *   showHistorik(cardId)            → hent changelog + vis i modal
 *   showBonInfo(cardId)             → hent fuld bon + vis i modal
 *   showRavarer(cardId)             → hent ingredienser + vis i modal
 *
 * Afhænger af:
 *   shared/api.js    → fetchBon(), fetchBonChangelog(), fetchBonIngredients(), postGrocyShoppingList()
 *   shared/utils.js  → esc(), statusToFrontend(), formatDanishDate()
 *   BonConfig.js     → BON_CONFIG (til status-labels)
 * ════════════════════════════════════════════════════════════
 */

/* ══════════════════════════════════════════════════════════════
   GENERISK MODAL
   ══════════════════════════════════════════════════════════════ */

let _modalOverlay = null;

function openModal({ title, bodyHtml }) {
    // Erstat evt. eksisterende modal SYNKRONT — closeModal()'s 200ms fade ville
    // ellers efterlade den gamle overlay i DOM'en samtidig med den nye, og
    // helpers der bruger document.querySelector('.modal-body') (fx pakkelisten)
    // ville skrive ind i den døende modal. Instant-swap ved modal→modal.
    if (_modalOverlay) {
        document.removeEventListener('keydown', _modalEscHandler);
        _modalOverlay.remove();
        _modalOverlay = null;
    }

    _modalOverlay = document.createElement('div');
    _modalOverlay.className = 'modal-overlay';
    _modalOverlay.innerHTML = `
        <div class="modal-panel">
            <div class="modal-header">
                <div class="modal-title">${title}</div>
                <button class="modal-close" onclick="closeModal()">×</button>
            </div>
            <div class="modal-body">
                ${bodyHtml}
            </div>
        </div>
    `;

    // Klik på overlay (uden for panel) lukker
    closeOnOutsideClick(_modalOverlay, closeModal);

    document.body.appendChild(_modalOverlay);

    // Trigger animation (næste frame)
    requestAnimationFrame(() => {
        _modalOverlay.classList.add('open');
    });

    // Escape lukker
    document.addEventListener('keydown', _modalEscHandler);
}

function closeModal() {
    if (!_modalOverlay) return;

    document.removeEventListener('keydown', _modalEscHandler);

    _modalOverlay.classList.remove('open');
    const el = _modalOverlay;
    _modalOverlay = null;

    // Vent på transition, fjern derefter
    setTimeout(() => {
        el.remove();
    }, 200);
}

function _modalEscHandler(e) {
    if (e.key === 'Escape') closeModal();
}

/* ══════════════════════════════════════════════════════════════
   HISTORIK (CHANGELOG)
   ══════════════════════════════════════════════════════════════ */

/** Danske labels for changelog action-typer */
const _ACTION_LABELS = {
    'create':                 'Oprettet',
    'update':                 'Opdateret',
    'status_change':          'Statusskift',
    'delete':                 'Slettet',
    'grocy_consume':          'Lagertræk',
    'economic_draft_created': 'Fakturaudkast',
};

/** Danske labels for changelog feltnavne */
const _FIELD_LABELS = {
    'status':                  'Status',
    'kitchen_info':            'Køkkeninfo',
    'prep_ingredients_ready':  'Råvarer klar',
    'prep_supplies_ready':     'Emballage klar',
    'delivery_date':           'Leveringsdato',
    'pickup_time':             'Afhentningstid',
    'delivery_time':           'Leveringstid',
    'pax':                     'Antal kuverter',
    'total_units':             'Antal enheder',
    'delivery_type':           'Leveringstype',
    'delivery_method':         'Leveringsmetode',
    'customer_id':             'Kunde',
    'company_id':              'Firma',
    'delivery_address_id':     'Leveringsadresse',
    'kitchen_selects':         'Køkken vælger',
    'customer_collects':       'Kunde henter',
    'is_offer':                'Tilbud',
    'economic_draft_number':   'Udkast-nr.',
    'bon_lines':               'Varelinjer',
    'delivery_vehicle_id':     'Køretøj',
    'delivery_booking':        'Booking',
    'total_price':             'Total',
    'stock':                   'Lager',
};

/** Ikon-tegn per action-type */
const _ACTION_ICONS = {
    'create':                 '+',
    'update':                 '✎',
    'status_change':          '⇄',
    'delete':                 '×',
    'grocy_consume':          '⊖',
    'economic_draft_created': '¤',
};

/**
 * Formatér dato til dansk: "12. mar 2026 kl. 14:30"
 */
function _formatChangelogDate(isoStr) {
    if (!isoStr) return '';
    const d = parseServerDate(isoStr);
    if (!d || isNaN(d.getTime())) return isoStr;

    const months = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun',
                    'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
    const day   = d.getDate();
    const month = months[d.getMonth()];
    const year  = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const mins  = String(d.getMinutes()).padStart(2, '0');

    return `${day}. ${month} ${year} kl. ${hours}:${mins}`;
}

/**
 * Forsøg at oversætte en statusværdi til dens label.
 * Backend gemmer UPPERCASE koder (IGANG, KLAR, …),
 * BonConfig bruger lowercase keys (igang, klar, …).
 */
function _statusLabel(val) {
    if (!val) return '';
    const key = val.toLowerCase();
    const cfg = BON_CONFIG && BON_CONFIG.statuses && BON_CONFIG.statuses[key];
    return cfg ? cfg.label : val;
}

/**
 * Læs payloaden fra en `grocy_consume`-entry.
 *
 * `new_value` er maskin-data, ikke tekst — den har historisk haft tre former:
 *   'event_prep_owns_stock'          sentinel: træk bevidst sprunget over
 *   '[{product_name,amount,…}, …]'   rå results-array
 *   '{"state":…,"results":[…]}'      samme array pakket ind
 * Returnerer { kind: 'skipped'|'results'|'raw', results, raw }.
 */
function _parseConsumePayload(raw) {
    const txt = String(raw == null ? '' : raw).trim();
    if (!txt) return { kind: 'raw', raw: '' };
    if (txt === 'event_prep_owns_stock') return { kind: 'skipped', raw: txt };

    let parsed;
    try { parsed = JSON.parse(txt); } catch { return { kind: 'raw', raw: txt }; }

    const results = Array.isArray(parsed) ? parsed
                  : (parsed && Array.isArray(parsed.results)) ? parsed.results
                  : null;
    if (!results) return { kind: 'raw', raw: txt };
    return { kind: 'results', results, raw: txt };
}

/**
 * Blev status-skiftet tvunget igennem uden om det normale flow?
 * Payloaden er JSON fra serveren og kan i teorien være hvad som helst —
 * en fejl her må ikke vælte hele historikken.
 */
function _changelogWasForced(entry) {
    if (!entry || !entry.payload) return false;
    try {
        const p = typeof entry.payload === 'string' ? JSON.parse(entry.payload) : entry.payload;
        return p && p.was_forced === true;
    } catch { return false; }
}

/** Afkort en changelog-værdi så en maskin-payload ikke sluger hele modalen. */
function _clipChangelogValue(v, max) {
    const s = String(v == null ? '' : v);
    const lim = max || 300;
    return s.length > lim ? s.slice(0, lim) + '…' : s;
}

/** Kort tal-format: 0.0134 → "0,013", 18 → "18" (ingen efterhængte nuller) */
function _fmtConsumeAmount(v) {
    const n = Number(v);
    if (!isFinite(n)) return '';
    return n.toLocaleString('da-DK', { maximumFractionDigits: 3 });
}

/**
 * Detalje-HTML for en `grocy_consume`-entry.
 *
 * Uden det her dumper den generiske gren hele results-JSON'en (typisk 30+
 * produkter, flere tusind tegn) direkte i historikken, så alt andet drukner.
 * Vi viser en tællende opsummering og lægger produktlisten i en <details>.
 */
function _buildConsumeDetail(entry) {
    const p = _parseConsumePayload(entry.new_value);

    if (p.kind === 'skipped') {
        return '<div class="changelog-detail">Lager ikke trukket — event-prep ejer HQ-lageret</div>';
    }
    if (p.kind === 'raw') {
        // Ukendt format: vis det, men afkortet så det ikke sluger modalen.
        const short = p.raw.length > 200 ? p.raw.slice(0, 200) + '…' : p.raw;
        return short ? `<div class="changelog-detail">${esc(short)}</div>` : '';
    }

    const results = p.results;
    const failed  = results.filter(r => r && r.success === false);
    const partial = results.filter(r => r && r.partial);
    const okCount = results.length - failed.length;

    const bits = [`<span class="new-value">${okCount} ${okCount === 1 ? 'vare' : 'varer'} trukket fra lager</span>`];
    if (partial.length) bits.push(`${partial.length} delvist (rest på indkøbsliste)`);
    if (failed.length)  bits.push(`<span class="changelog-warn">${failed.length} fejlede</span>`);

    let html = `<div class="changelog-detail">${bits.join(' · ')}</div>`;

    if (results.length) {
        const rows = results.map(r => {
            const name = esc(r.product_name || ('#' + (r.product_id ?? '?')));
            const amt  = _fmtConsumeAmount(r.amount);
            const flag = r.success === false ? ' <span class="changelog-warn">fejl</span>'
                       : r.partial          ? ' <span class="changelog-warn">delvist</span>'
                       : '';
            return `<li><span>${name}</span><span>${amt}${flag}</span></li>`;
        }).join('');
        html += `<details class="changelog-payload">
            <summary>Vis varer (${results.length})</summary>
            <ul>${rows}</ul>
        </details>`;
    }

    return html;
}

/**
 * Byg HTML for én changelog-entry
 */
function _buildChangelogEntry(entry) {
    const actionLabel = _ACTION_LABELS[entry.action] || entry.action;
    const actionIcon  = _ACTION_ICONS[entry.action]  || '•';
    const iconClass   = 'action-' + (entry.action || 'update');

    let detailHtml = '';

    // Flyver-entries: speciel rendering med ✈-ikon
    if (entry.field_name === 'notification') {
        const timeStr = _formatChangelogDate(entry.created_at);
        const userStr = entry.user_name ? esc(entry.user_name) : '';
        return '<div class="changelog-entry">'
            + '<div class="changelog-icon action-flyver">\u2708</div>'
            + '<div class="changelog-content">'
            +     '<div class="changelog-action-label">Flyver</div>'
            +     '<div class="changelog-detail">' + esc(entry.notes || entry.new_value || '') + '</div>'
            +     '<div class="changelog-meta">'
            +         '<span class="changelog-time">' + timeStr + '</span>'
            +         (userStr ? '<span class="changelog-user">\u2014 ' + userStr + '</span>' : '')
            +     '</div>'
            + '</div>'
            + '</div>';
    }

    if (entry.action === 'grocy_consume') {
        // Maskin-payload — må aldrig dumpes rå (se _buildConsumeDetail).
        detailHtml = _buildConsumeDetail(entry);
    } else if (entry.action === 'create') {
        detailHtml = '<span class="changelog-detail">Bon oprettet</span>';
    } else if (entry.action === 'status_change') {
        const oldLabel = _statusLabel(entry.old_value);
        const newLabel = _statusLabel(entry.new_value);
        // Overstyring markeres. Alle indloggede kan overstyre en status-vej der
        // ikke findes i flowet (aug 2026), så et forceret skift ser ellers ud
        // præcis som et almindeligt — og netop dét er hvad man leder efter
        // bagefter, fordi automatikken bag de normale trin blev sprunget over.
        const forced = _changelogWasForced(entry);
        detailHtml = `<div class="changelog-detail">
            <span class="old-value">${esc(oldLabel)}</span>
            <span class="arrow">→</span>
            <span class="new-value">${esc(newLabel)}</span>
            ${forced ? '<span class="changelog-forced" title="Ikke en normal status-vej — kontroller og automatik blev sprunget over">overstyret</span>' : ''}
        </div>`;
    } else if (entry.field_name) {
        const fieldLabel = _FIELD_LABELS[entry.field_name] || entry.field_name;
        const parts = [`<strong>${esc(fieldLabel)}</strong>`];
        // Værdierne afkortes: changelog bruges også til maskin-payloads, og en
        // enkelt JSON-klump på flere tusind tegn skubber al anden historik ud.
        const oldVal = _clipChangelogValue(entry.old_value);
        const newVal = _clipChangelogValue(entry.new_value);

        if (entry.old_value && entry.new_value) {
            parts.push(`: <span class="old-value">${esc(oldVal)}</span>`);
            parts.push(`<span class="arrow">→</span>`);
            parts.push(`<span class="new-value">${esc(newVal)}</span>`);
        } else if (entry.new_value) {
            parts.push(`: <span class="new-value">${esc(newVal)}</span>`);
        } else if (entry.old_value) {
            parts.push(`: <span class="old-value">${esc(oldVal)}</span> (fjernet)`);
        }
        detailHtml = `<div class="changelog-detail">${parts.join('')}</div>`;
    }

    // Booking, auto-satte tider og leverings-hændelser lægger forklaringen i
    // `notes` og kun rå id'er i new_value ("delivery_vehicle_id: 7"). Uden
    // noten er de entries reelt ulæselige.
    const noteStr  = String(entry.notes || '').trim();
    const noteHtml = (noteStr && noteStr !== String(entry.new_value || '').trim())
        ? `<div class="changelog-note">${esc(noteStr)}</div>`
        : '';

    const timeStr = _formatChangelogDate(entry.created_at);
    const userStr = entry.user_name ? esc(entry.user_name) : '';

    return `<div class="changelog-entry">
        <div class="changelog-icon ${iconClass}">${actionIcon}</div>
        <div class="changelog-content">
            <div class="changelog-action-label">${esc(actionLabel)}</div>
            ${detailHtml}
            ${noteHtml}
            <div class="changelog-meta">
                <span class="changelog-time">${timeStr}</span>
                ${userStr ? `<span class="changelog-user">— ${userStr}</span>` : ''}
            </div>
        </div>
    </div>`;
}

/**
 * Åbn historik-modal for et bon-kort.
 * Kaldes fra action-bar: onclick="showHistorik('bon123')"
 */
async function showHistorik(cardIdOrOpts) {
    let bonId, bonNr;
    if (cardIdOrOpts && typeof cardIdOrOpts === 'object') {
        // { bonId, bonNumber } — bruges fra office (drawer, listview)
        bonId = String(cardIdOrOpts.bonId);
        bonNr = cardIdOrOpts.bonNumber ? '#' + cardIdOrOpts.bonNumber : '#' + bonId;
    } else {
        // Legacy: cardId fra bon-kort i kitchen
        const card = document.getElementById(cardIdOrOpts);
        if (!card) return;
        bonId = cardIdOrOpts.replace('bon', '');
        bonNr = card.querySelector('.bon-id')?.textContent?.trim() || '#' + bonId;
    }

    // Vis loading-tilstand
    openModal({
        title: `Historik — ${esc(bonNr)}`,
        bodyHtml: '<div class="changelog-empty">Henter historik…</div>',
    });

    try {
        const entries = await fetchBonChangelog(bonId);

        if (!entries || entries.length === 0) {
            // Opdater body med tom-tilstand
            const body = document.querySelector('.modal-body');
            if (body) body.innerHTML = '<div class="changelog-empty">Ingen historik endnu</div>';
            return;
        }

        const html = `<div class="changelog-list">${entries.map(_buildChangelogEntry).join('')}</div>`;

        const body = document.querySelector('.modal-body');
        if (body) body.innerHTML = html;
    } catch (err) {
        console.error('Fejl ved hentning af historik:', err);
        const body = document.querySelector('.modal-body');
        if (body) body.innerHTML = '<div class="changelog-empty">Kunne ikke hente historik. Prøv igen.</div>';
    }
}

/* ══════════════════════════════════════════════════════════════
   BON INFO — FULD DETALJEVISNING
   ══════════════════════════════════════════════════════════════ */

/** Danske labels for info-modal */
const _PAY_LABELS       = { invoice: 'Faktura', card: 'Kort', mobilepay: 'MobilePay', cash: 'Kontant', pos: 'POS',
                            barter: 'Modregning', sponsorship: 'Sponsorat' };
const _DEL_TYPE_LABELS  = { delivery: 'Levering', pickup: 'Afhentning', event: 'Event' };
const _DEL_METHOD_LABELS = { bike: 'Cykel', taxi: 'Taxa', volvo: 'Volvo', pickup: 'Afhentning' };
const _PRICE_CAT_LABELS = { store: 'Butik', catering: 'Catering', festival: 'Festival', produktion: 'Produktion', waiste: 'Waiste' };

/** Formatér beløb som dansk kr */
function _fmtKr(v) {
    if (v == null) return '—';
    return Number(v).toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr';
}

/**
 * Åbn info-modal for et bon-kort eller direkte med bonId.
 * Henter fuld bon via GET /api/bons/:id og viser alle detaljer.
 *
 * Kald fra action-bar:  showBonInfo('bon123')
 * Kald fra kalender:    showBonInfo(123, { showGotoButton: true, bonNumber: '3305' })
 */
async function showBonInfo(cardIdOrBonId, options) {
    var opts = options || {};
    var bonId, bonNr;

    if (typeof cardIdOrBonId === 'string' && cardIdOrBonId.startsWith('bon')) {
        // Kaldt fra bon-kort: cardId = 'bon123'
        var card = document.getElementById(cardIdOrBonId);
        if (!card) return;
        bonId = cardIdOrBonId.replace('bon', '');
        bonNr = card.querySelector('.bon-id')?.textContent?.trim() || '#' + bonId;
    } else {
        // Kaldt fra kalender: bonId = 123
        bonId = cardIdOrBonId;
        bonNr = opts.bonNumber ? '#' + opts.bonNumber : '#' + bonId;
    }

    // Brug global edit-handler hvis view har registreret en
    if (!opts.showEditButton && typeof window._bonInfoEditHandler === 'function') {
        opts.showEditButton = true;
        opts.showGotoButton = true;
        opts.onEdit = window._bonInfoEditHandler;
    }

    // Vis loading
    openModal({
        title: `Info — ${esc(bonNr)}`,
        bodyHtml: '<div class="changelog-empty">Henter bon-data…</div>',
    });

    try {
        const bon = await fetchBon(bonId);
        const overlay = document.querySelector('.modal-overlay:last-of-type') || document.querySelector('.modal-overlay');
        const body = overlay && overlay.querySelector('.modal-body');
        if (body) {
            body.innerHTML = _buildBonInfoHtml(bon);

            // Køkken-synlige kunde-/firma-påmindelser øverst (read-only)
            _renderInfoFlags(bon, body);

            // Mail-historik → changelog (async, non-blocking)
            _loadInfoMail(bonId, body).then(function() {
                _loadInfoHistorik(bonId, body);
            });

            // Knap-sektion (Gå til bon + Rediger)
            if (opts.showGotoButton || opts.showEditButton) {
                var gotoDiv = document.createElement('div');
                gotoDiv.className = 'info-goto-section';

                if (opts.showGotoButton) {
                    var now = new Date();
                    var today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
                    var targetPage = (bon.delivery_date <= today) ? '/kitchen/today.html' : '/kitchen/later.html';
                    var gotoBtn = document.createElement('button');
                    gotoBtn.className = 'info-goto-btn';
                    gotoBtn.textContent = 'Gå til bon \u2192';
                    gotoBtn.addEventListener('click', function() {
                        closeModal();
                        window.location.href = targetPage + '#bon' + bonId;
                    });
                    gotoDiv.appendChild(gotoBtn);
                }

                if (opts.showEditButton && typeof opts.onEdit === 'function') {
                    var editBtn = document.createElement('button');
                    editBtn.className = 'info-goto-btn info-edit-btn';
                    editBtn.textContent = 'Rediger';
                    editBtn.addEventListener('click', function() {
                        closeModal();
                        opts.onEdit(bonId);
                    });
                    gotoDiv.appendChild(editBtn);
                }

                body.appendChild(gotoDiv);
            }

            // Event-prep: pakkelisten er ellers kun tilgængelig fra et køkken-bon-kort,
            // som er dato-filtreret (I DAG / SENERE). En prep-bon fra i går kan derfor
            // ikke nås. Her gør vi pakkelisten tilgængelig fra kalenderen på enhver dato.
            if (bon.event_id && bon.price_category_code === 'produktion' && typeof showPakkeliste === 'function') {
                var pakkeDiv = document.createElement('div');
                pakkeDiv.className = 'info-goto-section';
                var pakkeBtn = document.createElement('button');
                pakkeBtn.className = 'info-goto-btn';
                pakkeBtn.textContent = '📦 Pakkeliste';
                pakkeBtn.addEventListener('click', function() {
                    // Ingen closeModal() her — showPakkeliste→openModal erstatter
                    // info-modalen synkront. Et eksplicit closeModal() ville nulle
                    // _modalOverlay, så swap'et ikke ser den gamle modal, og
                    // renderen ville skrive ind i den døende overlay.
                    showPakkeliste({ bonId: bonId, bonNr: bonNr });
                });
                pakkeDiv.appendChild(pakkeBtn);
                body.appendChild(pakkeDiv);
            }
        }
    } catch (err) {
        console.error('Fejl ved hentning af bon-info:', err);
        const overlay = document.querySelector('.modal-overlay:last-of-type') || document.querySelector('.modal-overlay');
        const body = overlay && overlay.querySelector('.modal-body');
        if (body) body.innerHTML = '<div class="changelog-empty">Kunne ikke hente bon-data. Prøv igen.</div>';
    }
}

/**
 * Hent og vis mail-historik i info-modal (non-blocking).
 */
async function _loadInfoMail(bonId, bodyEl) {
    if (typeof fetchBonMail !== 'function' || typeof MailThread === 'undefined') return;
    try {
        const mailData = await fetchBonMail(bonId);
        const allMsgs = [];
        (mailData.threads || []).forEach(t => (t.messages || []).forEach(m => allMsgs.push(m)));

        // "Skriv mail" → fælles indgang til den rige mail-modal (hvis tilgængelig).
        var writeBtn = (typeof openBonMail === 'function')
            ? '<button type="button" class="info-mail-write" onclick="openBonMail(\'bon' + bonId + '\')">' + mailIcon(13) + ' Skriv mail</button>'
            : '';
        if (allMsgs.length === 0 && !writeBtn) return; // intet at vise

        var section = document.createElement('div');
        section.className = 'info-mail-section';
        var host = document.createElement('div');
        section.appendChild(host);
        if (writeBtn) {
            var bar = document.createElement('div');
            bar.className = 'info-mail-bar';
            bar.innerHTML = writeBtn;
            section.appendChild(bar);
        }

        // Indsæt før knap-sektionen (eller til sidst)
        var gotoSection = bodyEl.querySelector('.info-goto-section');
        if (gotoSection) bodyEl.insertBefore(section, gotoSection);
        else bodyEl.appendChild(section);

        MailThread.renderHistory(host, {
            threads: mailData.threads,
            header: mailIcon(14) + ' Mail',
            emptyText: 'Ingen korrespondance endnu',
            maxHeight: 240,
            onMarkRead: (id) => markBonMailRead(bonId, id),
        });
    } catch (err) {
        // Stille fejl — mail er ikke kritisk for info-modal
        console.warn('[info-mail]', err.message);
    }
}

/**
 * Køkken-synlige kunde-/firma-påmindelser som read-only banner øverst i info-modalen.
 * Filtrerer bon.flags til show_in_kitchen=1. Ingen handlinger (kontoret styrer dem i
 * draweren). Skjult når der ingen er.
 */
function _renderInfoFlags(bon, bodyEl) {
    const flags = ((bon && bon.flags) || []).filter(function(f) {
        return f.show_in_kitchen === 1 || f.show_in_kitchen === undefined;
    });
    if (!flags.length) return;
    const rows = flags.map(function(f) {
        return '<div class="info-paamindelse-item">📌 <span class="info-paamindelse-title">' + esc(f.title) + '</span>' +
            (f.body ? '<span class="info-paamindelse-body">' + esc(f.body) + '</span>' : '') + '</div>';
    }).join('');
    const banner = document.createElement('div');
    banner.className = 'info-paamindelse';
    banner.innerHTML = rows;
    bodyEl.insertBefore(banner, bodyEl.firstChild);  // øverst — mest synlig
}

/**
 * Hent og vis changelog i info-modalen som sammenklappelig sektion (non-blocking).
 * Historik er foldet ind i Info, så bon-kortet ikke behøver et separat ikon.
 */
async function _loadInfoHistorik(bonId, bodyEl) {
    if (typeof fetchBonChangelog !== 'function') return;
    try {
        const entries = await fetchBonChangelog(bonId);
        if (!entries || entries.length === 0) return;

        const section = document.createElement('div');
        section.className = 'info-historik-section';

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'info-historik-toggle';
        toggle.innerHTML = '<span>Historik (' + entries.length + ')</span>'
            + '<span class="info-historik-caret">▾</span>';

        const list = document.createElement('div');
        list.className = 'info-historik-list';
        list.hidden = true;
        list.innerHTML = '<div class="changelog-list">'
            + entries.map(_buildChangelogEntry).join('') + '</div>';

        toggle.addEventListener('click', function() {
            const open = list.hidden;
            list.hidden = !open;
            section.classList.toggle('open', open);
        });

        section.appendChild(toggle);
        section.appendChild(list);

        const gotoSection = bodyEl.querySelector('.info-goto-section');
        if (gotoSection) bodyEl.insertBefore(section, gotoSection);
        else bodyEl.appendChild(section);
    } catch (err) {
        // Stille fejl — historik er ikke kritisk for info-modal
        console.warn('[info-historik]', err.message);
    }
}

/**
 * Byg HTML for fuld bon-info modal.
 */
function _buildBonInfoHtml(bon) {
    const _esc = typeof esc === 'function' ? esc : (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // Status
    const statusFe  = statusToFrontend(bon.status_code);
    const statusCfg = BON_CONFIG && BON_CONFIG.statuses && BON_CONFIG.statuses[statusFe];
    const statusLabel = statusCfg ? statusCfg.label : (bon.status_label || bon.status_code);
    const statusColor = statusCfg ? statusCfg.color : (bon.status_color || '#999');
    const statusText  = statusCfg ? statusCfg.text  : '#fff';

    // Leveringsadresse
    let addrStr = '';
    if (bon.delivery_address) {
        const a = bon.delivery_address;
        addrStr = [a.street_name, a.street_nr].filter(Boolean).join(' ');
        if (a.street_name2) addrStr += ', ' + a.street_name2;
        if (a.postal_code || a.city) addrStr += ', ' + [a.postal_code, a.city].filter(Boolean).join(' ');
    } else if (bon.customer_collects) {
        addrStr = 'Afhentes';
    }

    // Leveringstype + metode
    const delType   = _DEL_TYPE_LABELS[bon.delivery_type] || bon.delivery_type || '';
    const delMethod = _DEL_METHOD_LABELS[bon.delivery_method] || bon.delivery_method || '';
    const deliveryStr = [delType, delMethod].filter(Boolean).join(' · ');

    // Dato
    const dateStr = bon.delivery_date ? formatDanishDate(bon.delivery_date) : '';

    let html = '';

    // ── Overblik ──────────────────────────────────────────────
    html += '<div class="info-section">';
    html += `<div class="info-row">
        <span class="info-label">Status</span>
        <span class="info-value"><span class="info-status-badge" style="background:${statusColor};color:${statusText}">${_esc(statusLabel)}</span></span>
    </div>`;
    if (dateStr)           html += `<div class="info-row"><span class="info-label">Dato</span><span class="info-value">${_esc(dateStr)}</span></div>`;
    if (bon.pickup_time)   html += `<div class="info-row"><span class="info-label">Afhentning</span><span class="info-value">${_esc(bon.pickup_time)}</span></div>`;
    if (bon.delivery_time) html += `<div class="info-row"><span class="info-label">Levering kl.</span><span class="info-value">${_esc(bon.delivery_time)}</span></div>`;
    if (deliveryStr)       html += `<div class="info-row"><span class="info-label">Type</span><span class="info-value">${_esc(deliveryStr)}</span></div>`;
    if (bon.pax)           html += `<div class="info-row"><span class="info-label">Kuverter</span><span class="info-value">${bon.pax}</span></div>`;
    if (bon.total_units)   html += `<div class="info-row"><span class="info-label">Enheder</span><span class="info-value">${bon.total_units}</span></div>`;
    if (bon.boxes)         html += `<div class="info-row"><span class="info-label">Kasser</span><span class="info-value">${bon.boxes}</span></div>`;
    html += '</div>';

    // ── Kunde ─────────────────────────────────────────────────
    const custName = (bon.contact_name_full || '').trim();
    const compName = bon.company_name || '';
    if (custName || compName) {
        html += '<div class="info-section">';
        html += '<div class="info-section-title">Kunde</div>';
        const nameParts = [custName, compName].filter(Boolean);
        html += `<div class="info-customer-name">${_esc(nameParts.join(' · '))}</div>`;
        if (addrStr) html += `<div class="info-customer-detail">${_esc(addrStr)}</div>`;
        // Telefonnumre: bestiller + dagskontakt
        if (bon.contact_phone) {
            const label = bon.company_phone && bon.company_phone !== bon.contact_phone ? ' <span class="info-phone-label">Bestiller</span>' : '';
            html += `<div class="info-customer-detail">📞 ${_esc(bon.contact_phone)}${label}</div>`;
        }
        if (bon.company_phone && bon.company_phone !== bon.contact_phone) {
            html += `<div class="info-customer-detail">📞 ${_esc(bon.company_phone)} <span class="info-phone-label">Dagskontakt</span></div>`;
        }
        if (bon.contact_email) html += `<div class="info-customer-detail">${mailIcon(12)} ${_esc(bon.contact_email)}</div>`;
        html += '</div>';
    }

    // ── Menulinjer ────────────────────────────────────────────
    // Slå ens linjer sammen — se shared/bon_lines.js. Gamle bons kan have
    // samme vare spredt over flere rækker; kortet merger allerede, og
    // info-modalen skal vise det samme.
    const lines = BonLines.mergeLines(bon.lines || []);
    if (lines.length > 0) {
        const mainLines = lines.filter(l => !l.is_accessory);
        const accLines  = lines.filter(l => l.is_accessory);

        html += '<div class="info-section">';
        html += '<div class="info-section-title">Menulinjer</div>';
        html += '<div class="info-lines">';

        for (const l of mainLines) {
            html += _buildInfoLine(l, _esc);
        }
        if (accLines.length > 0) {
            html += '<div class="info-lines-divider"></div>';
            for (const l of accLines) {
                html += _buildInfoLine(l, _esc);
            }
        }
        html += '</div>';

        // Totals
        const lineSum = lines.reduce((s, l) => s + (l.line_total || 0), 0);
        html += '<div class="info-totals">';
        if (bon.delivery_price != null && bon.delivery_price > 0) {
            html += `<div class="info-total-row"><span>Levering</span><span>${_fmtKr(bon.delivery_price)}</span></div>`;
        }
        const grand = (bon.total_with_delivery != null) ? bon.total_with_delivery
                     : (lineSum + (bon.delivery_price || 0));
        if (grand > 0) {
            // Moms: 25% dansk moms (inkluderet i priserne) — se shared/moms.js
            const moms = window.Moms.momsOfIncl(grand);
            html += `<div class="info-total-row"><span>Heraf moms</span><span>${_fmtKr(moms)}</span></div>`;
            html += `<div class="info-total-row info-total-grand"><span>I alt</span><span>${_fmtKr(grand)}</span></div>`;
        }
        html += '</div>';
        html += '</div>';
    }

    // ── Noter ─────────────────────────────────────────────────
    const hasNotes = bon.kitchen_info || bon.customer_wishes || bon.internal_notes || bon.delivery_notes;
    if (hasNotes) {
        html += '<div class="info-section">';
        html += '<div class="info-section-title">Noter</div>';
        if (bon.kitchen_info)    html += `<div class="info-note"><span class="info-note-label">Køkkeninfo</span><div class="info-note-text">${_esc(bon.kitchen_info)}</div></div>`;
        if (bon.customer_wishes) html += `<div class="info-note"><span class="info-note-label">Kundeønsker</span><div class="info-note-text">${_esc(bon.customer_wishes)}</div></div>`;
        if (bon.delivery_notes)  html += `<div class="info-note"><span class="info-note-label">Leveringsnoter</span><div class="info-note-text">${_esc(bon.delivery_notes)}</div></div>`;
        if (bon.internal_notes)  html += `<div class="info-note"><span class="info-note-label">Intern note</span><div class="info-note-text">${_esc(bon.internal_notes)}</div></div>`;
        html += '</div>';
    }

    // ── Betaling ──────────────────────────────────────────────
    const payLabel  = _PAY_LABELS[bon.payment_type] || bon.payment_type || '';
    const priceCat  = _PRICE_CAT_LABELS[bon.price_category] || bon.price_category || '';
    if (payLabel || priceCat) {
        html += '<div class="info-section">';
        html += '<div class="info-section-title">Betaling</div>';
        const parts = [payLabel, priceCat ? priceCat + '-priser' : ''].filter(Boolean);
        html += `<div class="info-payment">${_esc(parts.join(' · '))}</div>`;
        html += '</div>';
    }

    // ── Bud / kurerinfo ───────────────────────────────────────
    if (bon.courier_provider || bon.courier_arrival_time || (bon.delivery_cost != null && bon.delivery_cost > 0)) {
        html += '<div class="info-section">';
        html += '<div class="info-section-title">Bud</div>';
        if (bon.courier_provider)      html += `<div class="info-row"><span class="info-label">Firma</span><span class="info-value">${_esc(bon.courier_provider)}</span></div>`;
        if (bon.courier_arrival_time)  html += `<div class="info-row"><span class="info-label">Ankomst</span><span class="info-value">${_esc(bon.courier_arrival_time)}</span></div>`;
        if (bon.delivery_cost != null && bon.delivery_cost > 0) html += `<div class="info-row"><span class="info-label">Omkostning</span><span class="info-value">${_fmtKr(bon.delivery_cost)}</span></div>`;
        html += '</div>';
    }

    return html;
}

/**
 * Byg HTML for én menulinje i info-modalen.
 */
function _buildInfoLine(line, _esc) {
    const special = line.special_request
        ? `<div class="info-line-special">${_esc(line.special_request)}</div>`
        : '';
    const priceStr = line.line_total != null
        ? `<span class="info-line-total">${_fmtKr(line.line_total)}</span>`
        : '';
    const accessoryCls = line.is_accessory ? ' accessory' : '';

    return `<div class="info-line${accessoryCls}">
        <span class="info-line-qty">${line.quantity}</span>
        <span class="info-line-name">${_esc(line.product_name)}${special}</span>
        ${priceStr}
    </div>`;
}

/* ══════════════════════════════════════════════════════════════
   RÅVARER — INGREDIENSBEHOV
   ══════════════════════════════════════════════════════════════ */

const _STATUS_DOT = {
    mangler:   { dot: '🔴', cls: 'ing-status-mangler' },
    lav:       { dot: '🟡', cls: 'ing-status-lav' },
    // "Kan laves" er BEVIDST ikke grøn. Grøn betyder "tag den på hylden";
    // blå betyder "den skal laves først, og råvarerne er der". Slås de to
    // sammen, mister køkkenet det eneste signal om at der er arbejde inden
    // service — og det var netop dét signal der manglede (#266 §4.1).
    kan_laves: { dot: '🔵', cls: 'ing-status-kan-laves' },
    ok:        { dot: '🟢', cls: 'ing-status-ok' },
};

/**
 * Den status en række skal VISES med. Serveren leverer to: `status` er det
 * fysiske lager, `effective_status` er svaret på "kan retten laves?".
 * Et gammelt svar uden feltet opfører sig præcis som før.
 */
function _ingStatus(x) {
    return (x && x.effective_status) || (x && x.status) || 'ok';
}

/** "1 × Rødløg - Syltet" / "2 × Falaffel-stegning (skøn)" */
function _makeLabel(ing) {
    if (!ing.make_recipe_name) return 'skal laves';
    const n = ing.make_batches && ing.make_batches > 1 ? `${ing.make_batches} × ` : '';
    return `skal laves: ${n}${ing.make_recipe_name}${ing.make_estimated ? ' (skøn)' : ''}`;
}

// Gem seneste råvare-data for toggle
let _ravarerData = null;
let _ravarerLevel = 'production'; // 'production' | 'raw'

/**
 * Åbn råvarer-modal for et bon-kort.
 * Henter aggregerede ingredienser med lagerstatus.
 * Kaldes fra action-bar: onclick="showRavarer('bon123')"
 */
async function showRavarer(cardId) {
    const card = document.getElementById(cardId);
    if (!card) return;

    const bonId = cardId.replace('bon', '');
    const bonNr = card.querySelector('.bon-id')?.textContent?.trim() || '#' + bonId;

    openModal({
        title: `Råvarer — ${esc(bonNr)}`,
        bodyHtml: '<div class="changelog-empty">Henter ingrediensbehov…</div>',
    });

    try {
        const data = await fetchBonIngredients(bonId);
        _ravarerData = data;
        _ravarerLevel = 'production';
        const body = document.querySelector('.modal-body');
        if (body) body.innerHTML = _buildRavarerHtml(data);
    } catch (err) {
        console.error('Fejl ved hentning af ingredienser:', err);
        const body = document.querySelector('.modal-body');
        if (body) body.innerHTML = `<div class="changelog-empty">Kunne ikke hente ingredienser. Prøv igen.</div>`;
    }
}

/**
 * Pakkeliste-modal: vises kun på event-prep/top-up-bons (CLAUDE_EVENT.md §3).
 *
 * Datamodel: bon-linjerne er PRODUKTIONSMÅL ("60 Falafel"), men det der
 * faktisk pakkes er RÅVARER + EMBALLAGE (eksploderet via Grocy-BOM). Sandwich
 * laves on-the-spot på pladsen. To toggle-niveauer:
 *
 *   📦 Råvarer (default) — det fysiske pakkearbejde (720 Brød Rug, 60 kg
 *       falafel-mix, 8 kg salat, 60 RR Boks emballage…). Samme niveau som
 *       det Grocy faktisk trækker ved LEVERET via consumeRecipes.
 *   🔧 Produktion — bon-linjerne som måltal (60 Falafel + sub-recipes).
 *       Nyttigt for at se "hvad er målet" før man fokuserer på råvarer.
 *
 * Checkboxes pr. linje gemmes i sessionStorage. Hver niveau har sit eget
 * checkbox-state (man kan markere "Brød Rug pakket" uden at det rører
 * "Falafel-måltal nået").
 */
let _pakkeData = null;       // { production, raw } fra fetchBonIngredients
let _pakkeBon = null;        // bon-objekt (inkl. lines)
let _pakkeBonId = null;
let _pakkeLevel = 'pack';    // 'pack' = det vi pakker (produktions-niveau) | 'goal' = retter der skal laves
// product_id → packed_amount i LAGER-enhed. Samme enhed som serveren og databasen
// bruger (jf. db/helpers.js). Feltet i UI'et viser derimod produktets VISNINGS-enhed
// ("150 g", ikke "0,15"), så der konverteres ved ind- og udlæsning via
// _pakkeFactors nedenfor. Blandes de to sammen, trækkes der 1000× for meget (#352).
let _pakkeOverrides = {};
let _pakkeExtras = [];       // [{ product_id, product_name, amount, unit }] — ekstra varer oveni (allerede i lager-enhed)
// product_id → { factor, stockUnit } for de varer der vises i pakkelisten.
// factor = lager → vist tal. Fyldes når listen bygges, læses ved gem.
let _pakkeFactors = {};
let _pakkeRecipeFactors = {};// recipe_id → factor (skalering af underopskrifter, fx Frisk Grønt)
let _pakkeSaveTimer = null;  // debounce til auto-gem af overrides + extras + recipe-faktorer
let _pakkeProducts = null;   // Grocy produkt-cache til "tag ekstra med"-vælger (lazy)
let _pakkeUnitMap = null;    // qu_id → enheds-label (lazy, sammen med _pakkeProducts)

// Ældre sessionStorage-værdier ('raw'/'production') → nye ('pack'/'goal')
function _pakkeNormLevel(lvl) {
    if (lvl === 'raw') return 'pack';
    if (lvl === 'production') return 'goal';
    return (lvl === 'pack' || lvl === 'goal') ? lvl : 'pack';
}

async function showPakkeliste(cardIdOrObj) {
    let bonId, bonNr;
    if (cardIdOrObj && typeof cardIdOrObj === 'object') {
        // Kaldt uden bon-kort (fx fra kalenderens info-modal): { bonId, bonNr }
        bonId = String(cardIdOrObj.bonId);
        bonNr = cardIdOrObj.bonNr || ('#' + bonId);
    } else {
        // Kaldt fra et køkken-bon-kort: cardId = 'bon123'
        const card = document.getElementById(cardIdOrObj);
        if (!card) return;
        bonId = String(cardIdOrObj).replace('bon', '');
        bonNr = card.querySelector('.bon-id')?.textContent?.trim() || '#' + bonId;
    }
    _pakkeBonId = bonId;
    _pakkeLevel = _pakkeNormLevel(sessionStorage.getItem(`pakke_level_${bonId}`));
    openModal({
        title: `📦 Pakkeliste — ${esc(bonNr)}`,
        bodyHtml: '<div class="changelog-empty">Henter pakkeliste…</div>',
    });
    try {
        const [bonRes, ingredients, packing] = await Promise.all([
            fetch(`/api/bons/${bonId}`, { credentials: 'same-origin' }).then(r => r.json()),
            fetchBonIngredients(bonId).catch(() => ({ production: { ingredients: [], groups: [], sub_recipes: [] }, raw: { ingredients: [], groups: [] } })),
            fetch(`/api/bons/${bonId}/packing`, { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({ overrides: [], extras: [] })),
        ]);
        _pakkeBon = bonRes;
        _pakkeData = ingredients;
        // Override-map: product_id → packed_amount (buffer på direkte varer)
        _pakkeOverrides = {};
        for (const o of (packing.overrides || [])) _pakkeOverrides[o.product_id] = Number(o.packed_amount);
        // Ekstra-varer (lægges oveni opskrifterne)
        _pakkeExtras = (packing.extras || []).map(x => ({
            product_id: parseInt(x.product_id),
            product_name: x.product_name || '',
            amount: Number(x.amount),
            unit: x.unit || '',
        }));
        // Underopskrift-skalering: recipe_id → factor
        _pakkeRecipeFactors = {};
        for (const r of (packing.recipe_overrides || [])) {
            const f = Number(r.factor);
            if (f > 0) _pakkeRecipeFactors[r.recipe_id] = f;
        }
        _renderPakkeliste();
    } catch (err) {
        console.error('Fejl ved hentning af pakkeliste:', err);
        const body = document.querySelector('.modal-body');
        if (body) body.innerHTML = `<div class="changelog-empty">Kunne ikke hente pakkeliste: ${esc(err.message || '')}</div>`;
    }
}

function _setPakkeLevel(level) {
    if (!_pakkeData) return;
    _pakkeLevel = level;
    sessionStorage.setItem(`pakke_level_${_pakkeBonId}`, level);
    _renderPakkeliste();
}

// Gem pakke-justeringer til serveren (debounced). Sender både overrides (buffer
// på direkte varer — kun dem der afviger fra det BOM-beregnede) og extras (varer
// der tages med oveni). Resten bruger den beregnede mængde server-side.
function _schedulePakkeSave() {
    clearTimeout(_pakkeSaveTimer);
    _pakkeSaveTimer = setTimeout(_savePacking, 500);
}

// Find navn/enhed for et produkt-id i det resolvede datasæt (produktion først,
// så råvarer) — til snapshot på override-rækken.
function _pakkeFindIngredient(pid) {
    const inProd = (_pakkeData?.production?.ingredients || []).find(i => String(i.product_id) === String(pid));
    if (inProd) return inProd;
    return (_pakkeData?.raw?.ingredients || []).find(i => String(i.product_id) === String(pid));
}

/**
 * Faktor fra lager-enhed til det tal der vises for en ingrediens.
 *
 * Serveren sender den som `display_factor`. Fallback udleder den af forholdet
 * mellem vist og reelt behov — det dækker en cachet browser mod en ny server (og
 * omvendt), hvor den ellers ville falde tilbage til 1 og genskabe #352.
 */
function _pakkeDisplayFactor(ing) {
    const f = Number(ing?.display_factor);
    if (Number.isFinite(f) && f > 0) return f;
    const shown = Number(ing?.amount_needed), stock = Number(ing?.needed_stock);
    if (Number.isFinite(shown) && Number.isFinite(stock) && shown > 0 && stock > 0) return shown / stock;
    return 1;
}

async function _savePacking() {
    if (!_pakkeBonId) return;
    const overrides = Object.entries(_pakkeOverrides).map(([pid, amt]) => {
        const ing = _pakkeFindIngredient(pid);
        return {
            product_id: parseInt(pid),
            // _pakkeOverrides er allerede i lager-enhed — send råt videre.
            packed_amount: Number(amt),
            product_name: ing?.product_name || null,
            // Gem den ENHED tallet faktisk er i, ikke den brugeren så. Ellers er
            // rækken ikke til at tyde bagefter (og oprydningen efter #352 kan ikke
            // afgøre om en gammel række allerede er konverteret).
            unit: _pakkeFactors[pid]?.stockUnit || ing?.stock_unit_name || null,
        };
    });
    const extras = _pakkeExtras.map(x => ({
        product_id: x.product_id,
        amount: Number(x.amount),
        product_name: x.product_name || null,
        unit: x.unit || null,
    }));
    const recipe_overrides = Object.entries(_pakkeRecipeFactors).map(([rid, f]) => ({
        recipe_id: parseInt(rid),
        factor: Number(f),
    }));
    try {
        const res = await fetch(`/api/bons/${_pakkeBonId}/packing`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ overrides, extras, recipe_overrides }),
        });
        if (!res.ok) {
            const body = document.querySelector('.modal-body');
            if (res.status === 409 && body) {
                // Bonen blev leveret imens — genindlæs read-only
                // (objekt-form, så det også virker uden et bon-kort i DOM'en)
                showPakkeliste({ bonId: _pakkeBonId });
            }
            return;
        }
        const statusEl = document.querySelector('#pakkeProgress');
        if (statusEl) {
            const prev = statusEl.textContent;
            statusEl.textContent = '✓ gemt';
            statusEl.classList.add('pakke-progress-saved');
            setTimeout(() => { statusEl.classList.remove('pakke-progress-saved'); _updatePakkelisteProgress(document.querySelector('.modal-body')); }, 1200);
        }
    } catch (err) {
        console.error('Kunne ikke gemme pakke-justering:', err);
    }
}

function _renderPakkeliste() {
    const body = document.querySelector('.modal-body');
    if (!body) return;
    body.innerHTML = _buildPakkelisteHtml(_pakkeBon, _pakkeData, _pakkeLevel);
    // Bind checkbox-handlers (per-niveau storage så råvare/produktion er adskilte)
    const storageKey = `pakkeliste_${_pakkeBonId}_${_pakkeLevel}`;
    const state = JSON.parse(sessionStorage.getItem(storageKey) || '{}');
    body.querySelectorAll('input[data-pakke-line]').forEach(cb => {
        const lineKey = cb.dataset.pakkeLine;
        cb.checked = !!state[lineKey];
        cb.addEventListener('change', () => {
            state[lineKey] = cb.checked;
            sessionStorage.setItem(storageKey, JSON.stringify(state));
            _updatePakkelisteProgress(body);
            cb.closest('.pakke-line')?.classList.toggle('pakke-done', cb.checked);
        });
        cb.closest('.pakke-line')?.classList.toggle('pakke-done', cb.checked);
    });

    // Editbare mængde-felter for DIREKTE varer (override pr. product_id).
    // :not(.pakke-rfactor-input) — underopskrift-felterne håndteres separat nedenfor.
    body.querySelectorAll('.pakke-qty-input:not(.pakke-rfactor-input)').forEach(inp => {
        // Undgå at checkbox-toggle trigges når man klikker i feltet
        inp.addEventListener('click', e => e.preventDefault());
        const commit = () => {
            const pid = parseInt(inp.dataset.pakkePid);
            const computed = Number(inp.dataset.pakkeComputed);
            const val = inp.value === '' ? computed : Number(inp.value);
            if (Number.isNaN(val) || val < 0) { inp.value = String(computed); return; }
            // Sammenligningen sker i VIST enhed — det er det tal brugeren ser og
            // taster, og `computed` er afrundet dertil.
            if (Math.abs(val - computed) < 0.0001) {
                delete _pakkeOverrides[pid];
            } else {
                // …men det GEMTE tal skal være i lager-enhed, som resten af kæden
                // (server, DB, Grocy-consume) regner i. "150" i et g-felt er 0,15 kg.
                const factor = _pakkeFactors[pid]?.factor || 1;
                _pakkeOverrides[pid] = val / factor;
            }
            _schedulePakkeSave();
        };
        inp.addEventListener('change', () => { commit(); _renderPakkeliste(); });
        inp.addEventListener('input', commit);
    });

    // Editbare mængde-felter for UNDEROPSKRIFTER (skaleringsfaktor pr. recipe_id).
    // Indtastet mængde / standard-mængde = factor → råvarerne skaleres ved LEVERET.
    body.querySelectorAll('.pakke-rfactor-input').forEach(inp => {
        inp.addEventListener('click', e => e.preventDefault());
        const commit = () => {
            const rid = parseInt(inp.dataset.pakkeRid);
            const computed = Number(inp.dataset.pakkeRcomputed);
            const val = inp.value === '' ? computed : Number(inp.value);
            if (Number.isNaN(val) || val < 0 || !computed) { inp.value = String(computed); return; }
            const factor = val / computed;
            if (Math.abs(factor - 1) < 0.0001) {
                delete _pakkeRecipeFactors[rid];
            } else {
                _pakkeRecipeFactors[rid] = factor;
            }
            _schedulePakkeSave();
        };
        inp.addEventListener('change', () => { commit(); _renderPakkeliste(); });
        inp.addEventListener('input', commit);
    });

    // Reset-knapper (↺ → tilbage til standard) — både direkte varer og underopskrifter
    body.querySelectorAll('.pakke-reset').forEach(btn => {
        btn.addEventListener('click', e => {
            e.preventDefault();
            if (btn.dataset.pakkeRreset != null) {
                delete _pakkeRecipeFactors[parseInt(btn.dataset.pakkeRreset)];
            } else {
                delete _pakkeOverrides[parseInt(btn.dataset.pakkeReset)];
            }
            _schedulePakkeSave();
            _renderPakkeliste();
        });
    });

    // Ekstra-varer: mængde-redigering
    body.querySelectorAll('.pakke-extra-qty').forEach(inp => {
        inp.addEventListener('click', e => e.preventDefault());
        const commit = () => {
            const pid = parseInt(inp.dataset.pakkeXpid);
            const ex = _pakkeExtras.find(x => x.product_id === pid);
            if (!ex) return;
            const val = Number(inp.value);
            if (Number.isNaN(val) || val < 0) { inp.value = String(ex.amount); return; }
            ex.amount = val;
            _schedulePakkeSave();
        };
        inp.addEventListener('change', () => { commit(); _renderPakkeliste(); });
        inp.addEventListener('input', commit);
    });

    // Ekstra-varer: fjern
    body.querySelectorAll('.pakke-extra-remove').forEach(btn => {
        btn.addEventListener('click', e => {
            e.preventDefault();
            const pid = parseInt(btn.dataset.pakkeXremove);
            _pakkeExtras = _pakkeExtras.filter(x => x.product_id !== pid);
            _schedulePakkeSave();
            _renderPakkeliste();
        });
    });

    // "Tag ekstra med"-vælger: søg Grocy-varer
    const search = body.querySelector('.pakke-extra-search');
    if (search) {
        search.addEventListener('input', () => _pakkeRenderExtraResults(search.value));
        search.addEventListener('focus', () => { _pakkeEnsureProducts().then(() => _pakkeRenderExtraResults(search.value)); });
    }

    _updatePakkelisteProgress(body);
}

function _buildPakkelisteHtml(bon, data, level) {
    // Ens linjer slås sammen — se shared/bon_lines.js. En pakkeliste skal sige
    // "3× Kartoflen slider", ikke tre gange "1×".
    const lines = BonLines.mergeLines(bon.lines || []);
    if (lines.length === 0) {
        return '<div class="changelog-empty">Ingen linjer på denne bon endnu — tilføj varer først.</div>';
    }
    const fmt = (n) => n < 1 ? Number(n).toFixed(2) : (n < 10 ? Number(n).toFixed(1) : String(Math.round(n)));
    // Vægt-formatter til underopskrifter (kg/g): bevar op til 2 decimaler, så
    // "13,63 kg" ikke afrundes til "14". Heltal vises uden decimaler.
    const fmtW = (n) => { const r = Math.round(Number(n) * 100) / 100; return Number.isInteger(r) ? String(r) : String(r); };
    const eventLabel = bon.event_name ? ` til <strong>${esc(bon.event_name)}</strong>` : '';
    const isPack = (level === 'pack');
    const locked = (bon.inventory_deducted === 1);
    const toggle = `
        <div class="pakke-toggle">
            <button type="button" class="pakke-toggle-btn ${isPack ? 'active' : ''}" onclick="_setPakkeLevel('pack')">📦 Pak ned</button>
            <button type="button" class="pakke-toggle-btn ${!isPack ? 'active' : ''}" onclick="_setPakkeLevel('goal')">🍽 Skal laves</button>
        </div>`;
    const intro = `
        <div class="pakke-intro">
            <div>${isPack
                ? `Pak det her ned og tag det med fra HQ${eventLabel}. <em>(Dressinger er blandet hjemmefra og pakkes som færdige varer — ikke salt og peber hver for sig.)</em>`
                : `Det her skal kunne laves på eventet${eventLabel}.`}</div>
            <div class="pakke-progress" id="pakkeProgress">0 / 0 pakket</div>
        </div>${toggle}
        ${isPack && !locked ? '<div class="pakke-edit-hint">Klik på et tal for at justere — eller tag ekstra med nederst. Det trækkes fra HQ ved levering.</div>' : ''}
        ${isPack && locked ? '<div class="pakke-edit-hint pakke-locked-hint">🔒 Bonen er leveret — mængderne er trukket fra HQ og kan ikke ændres.</div>' : ''}`;

    let items = [];
    if (isPack) {
        // Pak-niveau (produktion): direkte varer + dressinger som færdige items.
        // Direkte varer er redigerbare (buffer-in-place → override). Dressinger
        // (underopskrifter) vises som ét færdigt item — ikke eksploderet til salt/peber.
        const prod = data?.production || {};
        items = (prod.ingredients || []).map(ing => {
            const pid = ing.product_id;
            const computed = Number(ing.amount_needed || ing.needed_stock || ing.needed_display || 0);
            const hasOverride = Object.prototype.hasOwnProperty.call(_pakkeOverrides, pid);
            const factor = _pakkeDisplayFactor(ing);
            _pakkeFactors[pid] = { factor, stockUnit: ing.stock_unit_name || null };
            return {
                type: 'edit',
                key: 'r' + pid,
                productId: pid,
                computed,
                // Override ligger i lager-enhed — vis den i samme enhed som feltet ellers viser
                qty: hasOverride ? Math.round(_pakkeOverrides[pid] * factor * 100) / 100 : computed,
                overridden: hasOverride,
                unit: ing.unit || ing.stock_unit || ing.purchase_unit || 'stk',
                name: ing.product_name || ing.name || '',
                category: ing.ingredient_group || ing.category || 'Øvrige',
                note: ing.special_request,
            };
        });
        for (const sub of (prod.sub_recipes || [])) {
            const rid = sub.recipe_id;
            const wg = Number(sub.weight_grams) || 0;
            const factor = _pakkeRecipeFactors[rid] || 1;
            if (wg > 0) {
                // Redigerbar: skaler underopskriftens råvarer via factor.
                const big = wg >= 1000;
                const compVal = big ? wg / 1000 : wg;   // standard-mængde i vist enhed
                items.push({
                    type: 'sub',
                    key: 'sub' + rid,
                    recipeId: rid,
                    computed: compVal,
                    qty: compVal * factor,
                    scaled: Math.abs(factor - 1) > 0.0001,
                    unit: big ? 'kg' : 'g',
                    name: sub.recipe_name,
                    category: 'Blandet hjemmefra',
                    note: null,
                });
            } else {
                // Ingen vægt (servings-baseret) — vis som før, ikke redigerbar.
                items.push({
                    type: 'sub-static',
                    key: 'sub' + rid,
                    displayAmount: sub.amount,
                    name: sub.recipe_name,
                    category: 'Blandet hjemmefra',
                    note: null,
                });
            }
        }
    } else {
        // Skal-laves-niveau: opskrifts-linjer som de står på bonen (referencen).
        items = lines.map(l => ({
            type: 'static',
            key: 'l' + l.id,
            qty: Number(l.quantity || 0),
            unit: l.unit || 'stk',
            name: l.product_name,
            category: l.category || 'Øvrigt',
            note: l.special_request,
        }));
    }
    if (items.length === 0) {
        return intro + `<div class="changelog-empty">Ingen ${isPack ? 'varer' : 'linjer'} fundet. ${isPack ? 'Tjek at opskrifterne har ingredienser i Grocy.' : 'Tilføj linjer til bonen.'}</div>`;
    }

    // Grupper efter kategori
    const groups = {};
    for (const it of items) {
        (groups[it.category] = groups[it.category] || []).push(it);
    }
    let html = intro + `<div class="pakke-groups">`;
    const sortedKeys = Object.keys(groups).sort((a, b) => {
        // Emballage altid sidst
        const aE = /emballage|kasser/i.test(a), bE = /emballage|kasser/i.test(b);
        if (aE !== bE) return aE ? 1 : -1;
        return a.localeCompare(b, 'da');
    });
    for (const cat of sortedKeys) {
        html += `<div class="pakke-group">
            <div class="pakke-group-head">${esc(cat)} <span class="pakke-group-count">(${groups[cat].length})</span></div>`;
        for (const it of groups[cat]) {
            let qtyCell, unitCell, resetBtn = '';
            const showStd = it.overridden || (it.type === 'sub' && it.scaled);
            if (it.type === 'sub-static') {
                // Servings-baseret underopskrift: forformateret mængde, ikke redigerbar.
                qtyCell = `<span class="pakke-qty pakke-qty-sub">${esc(it.displayAmount || '')}</span>`;
                unitCell = '';
            } else if (it.type === 'sub' && !locked) {
                // Underopskrift med vægt: redigerbar → skalerer råvarer proportionalt.
                qtyCell = `<input type="number" min="0" step="any" class="pakke-qty-input pakke-rfactor-input ${it.scaled ? 'pakke-qty-edited' : ''}"
                        value="${fmtW(it.qty)}" data-pakke-rid="${it.recipeId}" data-pakke-rcomputed="${it.computed}"
                        title="${it.scaled ? 'Standard: ' + fmtW(it.computed) : ''}">`;
                unitCell = `<span class="pakke-unit">${esc(it.unit)}</span>`;
                resetBtn = it.scaled
                    ? `<button type="button" class="pakke-reset" data-pakke-rreset="${it.recipeId}" title="Nulstil til standard (${fmtW(it.computed)})">↺</button>`
                    : '';
            } else if (it.type === 'edit' && !locked) {
                qtyCell = `<input type="number" min="0" step="any" class="pakke-qty-input ${it.overridden ? 'pakke-qty-edited' : ''}"
                        value="${fmt(it.qty)}" data-pakke-pid="${it.productId}" data-pakke-computed="${it.computed}"
                        data-pakke-name="${esc(it.name)}" data-pakke-unit="${esc(it.unit)}"
                        title="${it.overridden ? 'Standard: ' + fmt(it.computed) : ''}">`;
                unitCell = `<span class="pakke-unit">${esc(it.unit)}</span>`;
                resetBtn = it.overridden
                    ? `<button type="button" class="pakke-reset" data-pakke-reset="${it.productId}" data-pakke-computed="${it.computed}" title="Nulstil til standard (${fmt(it.computed)})">↺</button>`
                    : '';
            } else {
                // Låst (leveret): vis skaleret/justeret mængde som tekst.
                qtyCell = `<span class="pakke-qty ${showStd ? 'pakke-qty-edited' : ''}">${(it.type === 'sub' ? fmtW : fmt)(it.qty)}</span>`;
                unitCell = `<span class="pakke-unit">${esc(it.unit || '')}</span>`;
            }
            html += `<label class="pakke-line">
                <input type="checkbox" data-pakke-line="${esc(it.key)}">
                ${qtyCell}
                ${unitCell}
                <span class="pakke-name">${esc(it.name)}</span>
                ${showStd ? `<span class="pakke-orig">(standard ${(it.type === 'sub' ? fmtW : fmt)(it.computed)})</span>` : ''}
                ${resetBtn}
                ${it.note ? `<span class="pakke-note">— ${esc(it.note)}</span>` : ''}
            </label>`;
        }
        html += `</div>`;
    }
    html += `</div>`;

    // Ekstra-varer (kun pak-niveau): buffer der tages med OVENI opskrifterne.
    if (isPack && (_pakkeExtras.length > 0 || !locked)) {
        html += `<div class="pakke-extras">
            <div class="pakke-extras-head">➕ Ekstra med <span class="pakke-extras-sub">— buffer oveni opskrifterne</span></div>`;
        for (const ex of _pakkeExtras) {
            const qtyCell = locked
                ? `<span class="pakke-qty">${fmt(ex.amount)}</span>`
                : `<input type="number" min="0" step="any" class="pakke-extra-qty" value="${fmt(ex.amount)}" data-pakke-xpid="${ex.product_id}">`;
            const removeBtn = locked ? '' : `<button type="button" class="pakke-extra-remove" data-pakke-xremove="${ex.product_id}" title="Fjern">×</button>`;
            html += `<label class="pakke-line pakke-extra-line">
                <input type="checkbox" data-pakke-line="x${ex.product_id}">
                ${qtyCell}
                <span class="pakke-unit">${esc(ex.unit || '')}</span>
                <span class="pakke-name">${esc(ex.product_name || ('#' + ex.product_id))}</span>
                ${removeBtn}
            </label>`;
        }
        if (!locked) {
            html += `<div class="pakke-extra-add">
                <input type="text" class="pakke-extra-search" placeholder="+ Tag ekstra med — søg vare…" autocomplete="off">
                <div class="pakke-extra-results"></div>
            </div>`;
        }
        html += `</div>`;
    }

    html += `<div class="pakke-doctrine">
            ${isPack
                ? 'Når prep-bonnen sættes til <strong>LEVERET</strong>, trækker Grocy råvarerne bag dressingerne <em>+ de ekstra varer</em> fra HQ-lageret. Du ser de færdige varer — Grocy holder styr på komponenterne.'
                : 'Det er målet for hvad der skal kunne laves på eventet. Skift til 📦 Pak ned for at se hvad der pakkes.'}
        </div>`;

    // Read-only forhåndsvisning af lagertrækket — se præcis hvad LEVERET ville
    // trække fra HQ (inkl. ekstra-varer) UDEN at røre lageret.
    if (isPack) {
        html += `<div class="pakke-preview">
            <button type="button" class="pakke-preview-btn" onclick="_pakkePreviewConsume(this)">🔍 Forhåndsvis lagertræk</button>
            <span class="pakke-preview-hint">Se præcis hvad LEVERET ville trække fra HQ — uden at røre lageret</span>
            <div class="pakke-preview-panel" id="pakkePreviewPanel"></div>
        </div>`;
    }

    // "Marker som LEVERET" direkte fra pakkelisten — det naturlige sted at
    // afslutte pakningen. Confirm-advarsel inden (lagertrækket sker ved LEVERET).
    const terminal = ['LEVERET', 'FAKTURERET', 'BETALT', 'AFSLUTTET', 'AFLYST'];
    if (!locked && bon.status_code && !terminal.includes(bon.status_code)) {
        html += `
        <div class="pakke-deliver">
            <button type="button" class="pakke-deliver-btn" onclick="_pakkeMarkDelivered()">🚚 Pakket &amp; afsted — marker som LEVERET</button>
            <span class="pakke-deliver-hint">Trækker mængderne ovenfor fra HQ-lageret</span>
            <span class="pakke-deliver-err" id="pakkeDeliverErr"></span>
        </div>`;
    }
    return html;
}

// Hent Grocy-produkter + enheder til "tag ekstra med"-vælgeren (lazy, én gang).
async function _pakkeEnsureProducts() {
    if (_pakkeProducts) return;
    try {
        const [products, units] = await Promise.all([
            fetch('/api/grocy/products', { credentials: 'same-origin' }).then(r => r.json()),
            fetch('/api/grocy/quantity-units', { credentials: 'same-origin' }).then(r => r.json()).catch(() => []),
        ]);
        _pakkeUnitMap = {};
        for (const u of (units || [])) _pakkeUnitMap[u.id] = u.name_short || u.name || '';
        _pakkeProducts = (products || []).map(p => ({
            id: parseInt(p.id),
            name: p.name || '',
            unit: _pakkeUnitMap[p.qu_id_stock] || '',
        })).filter(p => p.id && p.name).sort((a, b) => a.name.localeCompare(b.name, 'da'));
    } catch (err) {
        console.error('Kunne ikke hente produkter til ekstra-vælger:', err);
        _pakkeProducts = [];
    }
}

// Render søgeresultater i ekstra-vælgeren (filtreret på navn, ekskl. allerede valgte).
function _pakkeRenderExtraResults(q) {
    const box = document.querySelector('.pakke-extra-results');
    if (!box) return;
    const term = (q || '').trim().toLowerCase();
    if (!_pakkeProducts || term.length < 2) { box.innerHTML = ''; return; }
    const already = new Set(_pakkeExtras.map(x => x.product_id));
    const matches = _pakkeProducts
        .filter(p => p.name.toLowerCase().includes(term) && !already.has(p.id))
        .slice(0, 12);
    if (!matches.length) { box.innerHTML = '<div class="pakke-extra-nohit">Ingen varer matcher</div>'; return; }
    box.innerHTML = matches.map(p =>
        `<button type="button" class="pakke-extra-hit" data-pakke-xadd="${p.id}">${esc(p.name)}${p.unit ? ` <span class="pakke-extra-hit-unit">${esc(p.unit)}</span>` : ''}</button>`
    ).join('');
    box.querySelectorAll('.pakke-extra-hit').forEach(btn => {
        btn.addEventListener('click', () => _pakkeAddExtra(parseInt(btn.dataset.pakkeXadd)));
    });
}

// Læg en vare på ekstra-listen (default 1 i stock-enhed) og gem.
function _pakkeAddExtra(pid) {
    if (!_pakkeProducts) return;
    const p = _pakkeProducts.find(x => x.id === pid);
    if (!p || _pakkeExtras.some(x => x.product_id === pid)) return;
    _pakkeExtras.push({ product_id: pid, product_name: p.name, amount: 1, unit: p.unit || '' });
    _schedulePakkeSave();
    _renderPakkeliste();
}

// Read-only forhåndsvisning: hent og vis præcis hvad LEVERET ville trække fra HQ
// (opskrifts-komponenter + overrides + extras) uden at røre Grocy-lageret.
async function _pakkePreviewConsume(btn) {
    const panel = document.getElementById('pakkePreviewPanel');
    if (!panel || !_pakkeBonId) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Henter…'; }
    panel.innerHTML = '<div class="pakke-preview-loading">Beregner lagertræk…</div>';
    try {
        const data = await fetch(`/api/bons/${_pakkeBonId}/packing/consume-preview`, { credentials: 'same-origin' }).then(r => r.json());
        const items = data.items || [];
        const fmt = (n) => n == null ? '' : (Math.abs(n) < 1 ? Number(n).toFixed(2) : (Math.abs(n) < 10 ? Number(n).toFixed(1) : String(Math.round(n))));
        if (!items.length) {
            panel.innerHTML = '<div class="pakke-preview-loading">Intet at trække — bonen har ingen opskrifts-varer eller ekstra-varer.</div>';
        } else {
            // En vare Bon selv laver er ikke en mangel. Vurderingen kommer fra
            // serveren (`is_real_shortfall`), som træffer den med auto-batchens
            // egne funktioner — regnede vi den her, kunne skærmen komme til at
            // sige noget andet end det der faktisk sker ved LEVERET.
            const erÆgteMangel = (it) => it.shortfall > 0.001 && it.is_real_shortfall !== false;
            const anyShort = items.some(erÆgteMangel);
            const anyKøbes = items.some(it => erÆgteMangel(it) && !it.produced_by);
            let h = `<table class="pakke-preview-table"><thead><tr>
                <th>Vare</th><th class="num">Trækkes</th><th>Heraf</th><th class="num">På lager</th></tr></thead><tbody>`;
            for (const it of items) {
                const parts = [];
                if (it.override_amount != null) parts.push(`buffer-sat ${fmt(it.override_amount)}`);
                else if (it.recipe_amount > 0) parts.push(`opskrift ${fmt(it.recipe_amount)}`);
                if (it.extra_amount > 0) parts.push(`<span class="pakke-preview-extra">+ekstra ${fmt(it.extra_amount)}</span>`);
                let short = '';
                if (it.shortfall > 0.001) {
                    const mangler = it.produce_missing || [];
                    if (it.produced_by === 'bon' && !mangler.length) {
                        // Bon laver den ved LEVERET. Hele batches, så der laves
                        // typisk mere end der mangler — overskuddet står til næste bon.
                        const n = it.batches_made || 1;
                        short = `<span class="pakke-preview-makes" title="Bon blander den ved LEVERET og trækker råvarerne til den">`
                              + `↻ Bon laver ${n} batch${n === 1 ? '' : 'es'}${it.produce_amount ? ` (${fmt(it.produce_amount)} ${esc(it.unit || '')})` : ''}</span>`;
                    } else if (it.produced_by === 'bon') {
                        short = `<span class="pakke-preview-short" title="Bon kan ikke blande den — råvarerne rækker ikke">`
                              + `⚠ kan ikke laves: mangler ${esc(mangler.map(m => m.product_name).join(', '))}</span>`;
                    } else if (it.produced_by === 'personale') {
                        // RR-produktion. Bon rører den aldrig — det er en besked
                        // til køkkenet, ikke en indkøbslinje.
                        short = `<span class="pakke-preview-staff" title="Laves af personalet efter plan — Bon producerer den aldrig selv">`
                              + `⚠ mangler ${fmt(it.shortfall)} — skal laves</span>`;
                    } else {
                        short = `<span class="pakke-preview-short" title="HQ har ikke nok — resten lægges på indkøbslisten">⚠ mangler ${fmt(it.shortfall)}</span>`;
                    }
                }
                h += `<tr>
                    <td>${esc(it.product_name)}</td>
                    <td class="num"><strong>${fmt(it.final_amount)}</strong> <span class="pakke-preview-unit">${esc(it.unit || '')}</span></td>
                    <td class="breakdown">${parts.join(' ') || '—'}</td>
                    <td class="num">${fmt(it.in_stock)} ${short}</td>
                </tr>`;
            }
            h += `</tbody></table>`;
            const fod = anyShort
                ? ` · ⚠ noget mangler på HQ${anyKøbes ? ' (det der kan købes, lægges på indkøbslisten)' : ''}`
                : '';
            h += `<div class="pakke-preview-foot">${items.length} varer trækkes ved LEVERET${fod}. Intet er trukket endnu — dette er kun en forhåndsvisning.</div>`;
            panel.innerHTML = h;
        }
    } catch (err) {
        panel.innerHTML = `<div class="pakke-preview-loading">Kunne ikke hente forhåndsvisning: ${esc(err.message || '')}</div>`;
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔍 Forhåndsvis lagertræk'; }
    }
}

/**
 * Marker pakkelistens bon som LEVERET (med advarsel). LEVERET udløser
 * lagertrækket i Grocy (autoConsumeBonInventory), så springet skal bekræftes
 * eksplicit. Efter succes re-hentes bonen og listen vises låst (🔒).
 */
async function _pakkeMarkDelivered() {
    if (!_pakkeBonId || !_pakkeBon) return;
    const nr = _pakkeBon.bon_number ? `${_pakkeBon.bon_number}` : 'bonen';
    const ok = confirm(
        `Markér ${nr} som LEVERET?\n\n` +
        `Råvarerne på pakkelisten trækkes fra HQ-lageret i Grocy med det samme, ` +
        `og mængderne kan ikke justeres bagefter.`
    );
    if (!ok) return;
    const btn = document.querySelector('.pakke-deliver-btn');
    const errEl = document.getElementById('pakkeDeliverErr');
    if (errEl) errEl.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = 'Markerer som leveret…'; }
    try {
        const res = await fetch(`/api/bons/${_pakkeBonId}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ status_code: 'LEVERET' }),
        });
        if (!res.ok) {
            let msg = res.statusText;
            try { msg = (await res.json()).error || msg; } catch {}
            throw new Error(msg);
        }
        // Re-hent bonen direkte (kortet kan være fjernet fra DOM af SSE) og
        // vis listen i låst tilstand.
        const bonRes = await fetch(`/api/bons/${_pakkeBonId}`, { credentials: 'same-origin' }).then(r => r.json());
        _pakkeBon = bonRes;
        _renderPakkeliste();
    } catch (err) {
        console.error('Kunne ikke markere som leveret:', err);
        const e2 = document.getElementById('pakkeDeliverErr');
        if (e2) e2.textContent = 'Fejl: ' + (err.message || err);
        const b2 = document.querySelector('.pakke-deliver-btn');
        if (b2) { b2.disabled = false; b2.textContent = '🚚 Pakket & afsted — marker som LEVERET'; }
    }
}

function _updatePakkelisteProgress(body) {
    const inputs = body.querySelectorAll('input[data-pakke-line]');
    const total = inputs.length;
    const done = body.querySelectorAll('input[data-pakke-line]:checked').length;
    const el = body.querySelector('#pakkeProgress');
    if (el) {
        el.textContent = `${done} / ${total} pakket`;
        el.classList.toggle('pakke-progress-done', done === total && total > 0);
    }
}

/**
 * Sæt råvarer-niveau og re-render modal.
 */
function _setRavarerLevel(level) {
    if (!_ravarerData) return;
    _ravarerLevel = level;
    const body = document.querySelector('.modal-body');
    if (body) body.innerHTML = _buildRavarerHtml(_ravarerData);
}

/**
 * Formatér tal til dansk (1.234,56)
 */
function _fmtNum(v) {
    if (v == null) return '—';
    const n = Math.round(v * 100) / 100;
    return n.toLocaleString('da-DK', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/**
 * Byg HTML for ingrediens-modal.
 * Understøtter to niveauer: produktion (direkte + underopskrifter) og råvarer (alt fladt).
 * Grupperet efter Grocy ingredient_group med status-dots per linje.
 */
function _buildRavarerHtml(data) {
    const _esc = typeof esc === 'function' ? esc : (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // Vælg aktivt niveau — brug production/raw hvis tilgængelig, ellers bagudkompatibelt
    const hasLevels = data.production && data.raw;
    const level = hasLevels ? ((_ravarerLevel === 'raw') ? data.raw : data.production) : data;
    const groups = level.groups || data.groups || [];
    const subRecipes = level.sub_recipes || [];

    if (groups.length === 0 && subRecipes.length === 0) {
        let msg = 'Ingen ingredienser fundet.';
        if (data.lines_without_recipe && data.lines_without_recipe.length > 0) {
            msg += ' Ingen linjer har en Grocy-opskrift.';
        }
        return `<div class="changelog-empty">${msg}</div>`;
    }

    let html = '';

    // Toggle-knapper (kun hvis begge niveauer er tilgængelige)
    if (hasLevels) {
        const prodActive = _ravarerLevel === 'production' ? ' active' : '';
        const rawActive  = _ravarerLevel === 'raw' ? ' active' : '';
        html += `<div class="ing-level-toggle">
            <button class="ing-level-btn${prodActive}" onclick="_setRavarerLevel('production')">🔧 Produktion</button>
            <button class="ing-level-btn${rawActive}" onclick="_setRavarerLevel('raw')">📦 Råvarer</button>
        </div>`;
    }

    // Søgefelt
    html += `<div class="ing-search-wrap">
        <input type="text" class="ing-search" placeholder="Søg ingrediens…"
               oninput="_filterIngredients(this.value)">
    </div>`;

    // Render ingrediens-grupper
    for (const group of groups) {
        const groupTitle = group.name || 'Øvrige';

        html += '<div class="ing-group">';
        html += `<div class="ing-group-header" onclick="_toggleIngGroup(this)">
            <span class="ing-group-label">${_esc(groupTitle)}</span>
            <span class="ing-group-toggle">▾</span>
        </div>`;

        html += '<div class="ing-table">';
        for (const ing of group.ingredients) {
            const eff = _ingStatus(ing);
            const st = _STATUS_DOT[eff] || _STATUS_DOT.ok;
            // Et mellemprodukt kan ikke købes — det laves. En indkøbskurv på
            // "Rødløg - Sylt" ville lægge en uindkøbelig vare på listen.
            const showCart = (eff === 'mangler' || eff === 'lav') && !ing.producible;
            const purchaseAmount = ing.shortfall_purchase || 0;
            const purchaseUnit = ing.purchase_unit || '';
            const cartTitle = purchaseAmount > 0
                ? `Tilføj ${_fmtNum(purchaseAmount)} ${purchaseUnit} til indkøbsliste`
                : 'Tilføj til indkøbsliste';
            const cartBtn = showCart
                ? `<button class="ing-btn-cart" onclick="_addToShoppingList(this, ${ing.product_id}, ${purchaseAmount}, '${_esc(ing.product_name)}')" title="${cartTitle}">🛒</button>`
                : '';

            // Producerbare varer får en note der siger hvad der skal ske, og en
            // fold-ud med de råvarer det kræver — så "kan laves" ikke er en
            // påstand man skal tage på ordet.
            // Noten gælder KUN når der mangler noget. En vare der ligger på
            // hylden skal ikke have "skal laves" hæftet på sig, bare fordi den
            // også KAN laves — så ville halvdelen af listen bede om arbejde
            // der ikke skal udføres.
            const missing = (ing.make_shortfalls || []);
            let note = '';
            if (eff === 'ok')                     note = '';
            else if (eff === 'kan_laves')         note = `<span class="ing-make-note">${_esc(_makeLabel(ing))}</span>`;
            // Udbyttet mangler i Grocy, så vi kan ikke sige om råvarerne rækker.
            // Det er en huller i stamdata, ikke en mangel på hylden — og den
            // besked er mere brugbar end en mangelliste vi ikke kan stå inde for.
            else if (ing.producible && ing.make_status === 'ukendt')
                // Begge beskeder er sande, og de siger hver sin ting: hvad der
                // mangler på hylden, og hvad der mangler i Grocy.
                note = missing.length
                    ? `<span class="ing-sub-warn">${missing.length} råvare${missing.length === 1 ? '' : 'r'} mangler · udbytte ikke oplyst</span>`
                    : `<span class="ing-sub-warn">skal laves · udbytte ikke oplyst i Grocy</span>`;
            else if (ing.producible && missing.length) note = `<span class="ing-sub-warn">${missing.length} råvare${missing.length === 1 ? '' : 'r'} mangler</span>`;
            else if (ing.producible)              note = `<span class="ing-sub-warn">skal laves</span>`;

            const key = _esc(ing.product_name.toLowerCase());
            // Ved 'ukendt' er mangellisten den VERIFICERBARE opskrifts — den er
            // til at stå inde for. Er der ingen, er der heller intet at folde ud.
            const foldable = eff !== 'ok' && ing.producible
                             && (missing.length > 0 || eff === 'kan_laves');

            // Noten afkortes med ellipsis på smalle skærme — hele teksten skal
            // stadig kunne læses.
            const blockedBy = ing.make_blocked_recipe
                ? ` · ${ing.make_blocked_recipe} mangler råvarer` : '';
            const rowTitle = (eff !== 'ok' && ing.producible)
                ? ` title="${_esc(_makeLabel(ing))}${blockedBy ? _esc(blockedBy) : ''}${missing.length ? ' — mangler: ' + _esc(missing.map(s => s.product_name).join(', ')) : ''}"`
                : '';

            html += `<div class="ing-row ${st.cls}${foldable ? ' ing-sub-clickable' : ''}" data-ing-name="${key}"${rowTitle}${foldable ? ' onclick="_toggleSubRecipe(this)"' : ''}>
                <span class="ing-dot">${st.dot}</span>
                <span class="ing-name">${_esc(ing.product_name)}${note}</span>
                <span class="ing-amount">${_fmtNum(ing.amount_needed)}</span>
                <span class="ing-unit">${_esc(ing.unit)}</span>
                <span class="ing-stock">${_fmtNum(ing.amount_stock)}</span>
                <span class="ing-stock-unit">${_esc(ing.stock_unit || ing.unit)}</span>
                <span class="ing-action">${foldable ? '<span class="ing-sub-caret">▾</span>' : cartBtn}</span>
            </div>`;

            if (foldable) {
                html += `<div class="ing-sub-detail" data-ing-name="${key}">`;
                if (eff === 'kan_laves') {
                    html += `<div class="ing-sub-detail-note">Råvarerne til ${_esc(ing.make_recipe_name || 'opskriften')} er på lager.</div>`;
                }
                for (const s of missing) {
                    const sst = _STATUS_DOT[s.status] || _STATUS_DOT.ok;
                    html += `<div class="ing-sub-detail-row ${sst.cls}">
                        <span class="ing-dot">${sst.dot}</span>
                        <span class="ing-name">${_esc(s.product_name)}</span>
                        <span class="ing-amount">${_fmtNum(s.needed)}</span>
                        <span class="ing-unit"></span>
                        <span class="ing-stock">${_fmtNum(s.stock)}</span>
                        <span class="ing-stock-unit"></span>
                        <span class="ing-action"></span>
                    </div>`;
                }
                html += '</div>';
            }
        }
        html += '</div></div>';
    }

    // Underopskrifter (kun produktion-niveau)
    if (subRecipes.length > 0) {
        html += '<div class="ing-group">';
        html += `<div class="ing-group-header" onclick="_toggleIngGroup(this)">
            <span class="ing-group-label">🔗 Underopskrifter</span>
            <span class="ing-group-toggle">▾</span>
        </div>`;
        html += '<div class="ing-table">';
        for (const sr of subRecipes) {
            // Status rulles op fra underopskriftens råvarer (serveren). Ældre
            // svar uden status falder tilbage til grøn som før.
            const srEff = _ingStatus(sr);
            const st = _STATUS_DOT[srEff] || _STATUS_DOT.ok;
            const short = sr.shortfalls || [];
            const key = _esc(sr.recipe_name.toLowerCase());

            // En råvare der selv kan laves er ikke en mangel. Tælles den med,
            // står der "3 råvarer mangler" ved siden af en blå prik — og så
            // tror man ikke på nogen af delene.
            const realShort = short.filter(s => (s.effective_status || s.status) !== 'kan_laves');
            let warn = '';
            if (realShort.length > 0) {
                const label = srEff === 'mangler' ? 'mangler' : 'lavt lager';
                warn = `<span class="ing-sub-warn">${realShort.length} råvare${realShort.length === 1 ? '' : 'r'} · ${label}</span>`;
            } else if (srEff === 'kan_laves') {
                warn = '<span class="ing-make-note">råvarerne er der</span>';
            }

            html += `<div class="ing-row ing-sub-recipe ${st.cls}${short.length ? ' ing-sub-clickable' : ''}"
                data-ing-name="${key}"${short.length ? ' onclick="_toggleSubRecipe(this)"' : ''}>
                <span class="ing-dot">${st.dot}</span>
                <span class="ing-name">${_esc(sr.recipe_name)}${warn}</span>
                <span class="ing-amount">${_esc(sr.amount)}</span>
                <span class="ing-unit"></span>
                <span class="ing-stock"></span>
                <span class="ing-stock-unit"></span>
                <span class="ing-action">${short.length ? '<span class="ing-sub-caret">▾</span>' : ''}</span>
            </div>`;

            if (short.length > 0) {
                html += `<div class="ing-sub-detail" data-ing-name="${key}">`;
                for (const s of short) {
                    const sst = _STATUS_DOT[_ingStatus(s)] || _STATUS_DOT.ok;
                    html += `<div class="ing-sub-detail-row ${sst.cls}">
                        <span class="ing-dot">${sst.dot}</span>
                        <span class="ing-name">${_esc(s.product_name)}</span>
                        <span class="ing-amount">${_fmtNum(s.amount_needed)}</span>
                        <span class="ing-unit">${_esc(s.unit)}</span>
                        <span class="ing-stock">${_fmtNum(s.amount_stock)}</span>
                        <span class="ing-stock-unit">${_esc(s.stock_unit || s.unit)}</span>
                        <span class="ing-action"></span>
                    </div>`;
                }
                html += '</div>';
            }
        }
        html += '</div></div>';
    }

    // Linjer uden opskrift
    if (data.lines_without_recipe && data.lines_without_recipe.length > 0) {
        html += `<div class="ing-note">Uden Grocy-opskrift: ${data.lines_without_recipe.map(n => _esc(n)).join(', ')}</div>`;
    }

    return html;
}

/**
 * Filtrér ingredienser i Råvarer-modal baseret på søgeterm.
 * Skjuler rækker der ikke matcher og grupper uden synlige rækker.
 */
function _filterIngredients(term) {
    const q = term.toLowerCase().trim();
    const groups = document.querySelectorAll('.ing-group');

    for (const group of groups) {
        const rows = group.querySelectorAll('.ing-row');
        let visibleCount = 0;

        for (const row of rows) {
            const name = row.getAttribute('data-ing-name') || '';
            const match = !q || name.includes(q);
            row.style.display = match ? '' : 'none';
            if (match) visibleCount++;
        }

        // Underopskrifternes mangel-lister er ikke .ing-row — skjul dem sammen
        // med deres række. Ved match ryddes inline-style, så CSS'en igen styrer
        // om listen er foldet ud (.open) eller ej.
        for (const detail of group.querySelectorAll('.ing-sub-detail')) {
            const name = detail.getAttribute('data-ing-name') || '';
            detail.style.display = (!q || name.includes(q)) ? '' : 'none';
        }

        // Skjul hele gruppen hvis ingen synlige rækker
        group.style.display = visibleCount > 0 ? '' : 'none';
    }
}

/**
 * Fold en underopskrifts mangel-liste ud/ind.
 */
function _toggleSubRecipe(rowEl) {
    const detail = rowEl.nextElementSibling;
    if (!detail || !detail.classList.contains('ing-sub-detail')) return;
    detail.classList.toggle('open');
    rowEl.classList.toggle('expanded');
}

/**
 * Toggle fold/unfold af en gruppe.
 */
function _toggleIngGroup(headerEl) {
    const group = headerEl.closest('.ing-group');
    if (group) group.classList.toggle('collapsed');
}

/**
 * Tilføj til Grocy indkøbsliste.
 * Bruger shortfall_stock (i lager-enheder) som mængde.
 */
async function _addToShoppingList(btnEl, productId, amount, name) {
    btnEl.disabled = true;
    btnEl.textContent = '…';

    try {
        await postGrocyShoppingList([{ product_id: productId, amount: amount, note: name }]);
        btnEl.textContent = '✓';
        btnEl.classList.add('ing-btn-done');
    } catch (err) {
        console.error('Indkøbsliste fejl:', err);
        btnEl.textContent = '✗';
        btnEl.disabled = false;
        setTimeout(() => { btnEl.textContent = '🛒'; }, 2000);
    }
}
