/**
 * mobile/views/levering.js
 * ════════════════════════════════════════════════════════════
 * Courier-mobil — den interne chauffør (Volvo/cykel).
 *
 * Dagens ruter for den indloggede bruger: kør-fra-HQ, per-stop
 * leveret-markering, og et 3-trins problem-flow med foto.
 *
 * Mockup: docs/delivery/courier_mobile_v5.html — uden "Tilbage
 * til HQ"-kortet og uden dual-kontaktblokke (jf. spec §12).
 * ════════════════════════════════════════════════════════════
 */

var _lvContainer = null;
var _lvUser      = null;
var _lvData      = { routes: [] };
var _lvGeo       = null;    // { lat, lng } — bedste kendte position
var _lvDetail    = null;    // { routeId, stopId } når detalje-skærm vises

/* Problem-flow state */
var _lvProblem = null;      // { stop, route, step, type, photo, note }

var _LV_INCIDENTS = [
    { type: 'no_answer',           icon: '&#128245;', label: 'Ingen svar',            desc: 'Kunden tager ikke telefonen / åbner ikke' },
    { type: 'left_at_door',        icon: '&#128230;', label: 'Stillet på aftalt sted', desc: 'Aflagt ved døren / reception / aftalt sted' },
    { type: 'wrong_address',       icon: '&#128205;', label: 'Forkert adresse',       desc: 'Kan ikke finde / forkert info' },
    { type: 'returned_to_kitchen', icon: '&#8617;',   label: 'Retur til køkken',      desc: 'Kunne ikke leveres — maden med tilbage' },
    { type: 'damage',              icon: '&#9888;',   label: 'Skade',                 desc: 'Maden eller emballagen er beskadiget' },
    { type: 'other',               icon: '&#10067;',  label: 'Andet',                 desc: 'Beskriv selv' },
];

/* ── Entry ─────────────────────────────────────────────── */
async function initMobileLevering(container, user) {
    _lvContainer = container;
    _lvUser      = user || window._mUser || null;
    _lvDetail    = null;
    _lvProblem   = null;
    _lvRequestGeo();
    await _lvLoad();
}

function cleanupMobileLevering() {
    _lvDetail  = null;
    _lvProblem = null;
}

/* Position i baggrunden — blokerer aldrig brugeren. */
function _lvRequestGeo() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
        function(pos) { _lvGeo = { lat: pos.coords.latitude, lng: pos.coords.longitude }; },
        function() { /* afvist — fortsæt uden */ },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
}

/* ── Data ──────────────────────────────────────────────── */
async function _lvLoad() {
    if (!_lvContainer) return;
    _lvContainer.innerHTML = '<div class="m-loading">Henter dagens tur...</div>';
    try {
        _lvData = await fetchCourierToday();
    } catch (e) {
        _lvContainer.innerHTML = '<div class="m-bon-empty">Kunne ikke hente ruter</div>';
        return;
    }
    _lvRender();
}

function _lvFindStop(stopId) {
    for (var i = 0; i < _lvData.routes.length; i++) {
        var r = _lvData.routes[i];
        for (var j = 0; j < (r.stops || []).length; j++) {
            if (r.stops[j].stop_id === stopId) return { route: r, stop: r.stops[j] };
        }
    }
    return null;
}

/* ── Render-router ─────────────────────────────────────── */
function _lvRender() {
    if (_lvProblem)      { _lvRenderProblem(); return; }
    if (_lvDetail)       {
        var found = _lvFindStop(_lvDetail.stopId);
        if (found) { _lvRenderDetail(found.route, found.stop); return; }
        _lvDetail = null;
    }
    _lvRenderList();
}

/* ── Liste — dagens ruter ──────────────────────────────── */
function _lvRenderList() {
    var routes = _lvData.routes || [];
    if (!routes.length) {
        _lvContainer.innerHTML =
            '<div class="m-lv-empty">' +
                '<div class="m-lv-empty-icon">&#128666;</div>' +
                '<div>Ingen ture til dig i dag</div>' +
                '<div class="m-lv-empty-sub">Ruter du er tildelt som chauffør dukker op her.</div>' +
            '</div>';
        return;
    }

    var html = '';
    routes.forEach(function(r) {
        html += _lvRouteHeader(r);
        var stops = r.stops || [];
        if (!stops.length) {
            html += '<div class="m-bon-empty">Ingen stop på ruten</div>';
        } else {
            stops.forEach(function(s, i) {
                html += _lvStopCard(s, i + 1, stops.length);
            });
        }
    });
    _lvContainer.innerHTML = html;
    _lvAttachListHandlers();
}

function _lvRouteHeader(r) {
    var stops = r.stops || [];
    var done  = stops.filter(function(s) { return s.status !== 'planlagt'; }).length;
    var stats = [];
    stats.push(stops.length + ' stop');
    if (r.total_km)      stats.push(Math.round(r.total_km) + ' km');
    if (r.total_minutes) stats.push('ca. ' + _lvDur(r.total_minutes));

    var departed  = r.status === 'active' || r.status === 'completed';
    var completed = r.status === 'completed';

    var actionHtml = '';
    if (completed) {
        actionHtml = '<div class="m-lv-route-done">&#10004; Tur afsluttet</div>';
    } else if (!departed) {
        actionHtml = '<button class="m-lv-depart-btn" data-depart="' + r.id + '">' +
            '&#128666; Kør fra HQ' +
            (r.pickup_time ? ' &middot; ' + _lvTime(r.pickup_time) : '') +
            '</button>';
    } else {
        actionHtml = '<div class="m-lv-route-progress">' + done + ' af ' + stops.length + ' leveret';
        if (done === 0) {
            actionHtml += ' &middot; <button type="button" class="m-lv-undo-btn" data-undo-depart="' + r.id + '">Fortryd start</button>';
        }
        actionHtml += '</div>';
    }

    return (
        '<div class="m-lv-route">' +
            '<div class="m-lv-route-top">' +
                '<div class="m-lv-route-veh" style="background:' + (r.vehicle_color || '#8e631f') + '">' +
                    _lvVehicleIcon(r.vehicle_type) +
                '</div>' +
                '<div class="m-lv-route-info">' +
                    '<div class="m-lv-route-name">' + _lvEsc(r.vehicle_label || 'Tur') + '</div>' +
                    '<div class="m-lv-route-stats">' + stats.join(' &middot; ') + '</div>' +
                '</div>' +
            '</div>' +
            actionHtml +
        '</div>'
    );
}

function _lvStopCard(s, seq, total) {
    var st = s.status || 'planlagt';
    var when = _lvTime(s.eta || s.delivery_time);
    var badge = '';
    if (st === 'leveret') badge = '<span class="m-lv-badge leveret">&#10004; Leveret</span>';
    else if (st === 'problem') badge = '<span class="m-lv-badge problem">&#9888; Problem</span>';
    else if (s.status_code === 'KLAR') badge = '<span class="m-lv-badge klar">Klar</span>';

    return (
        '<div class="m-lv-stop' + (st !== 'planlagt' ? ' done' : '') + '" data-stop="' + s.stop_id + '">' +
            '<div class="m-lv-stop-seq ' + st + '">' +
                '<span class="m-lv-stop-num">' + seq + '</span>' +
                (when ? '<span class="m-lv-stop-time">' + when + '</span>' : '') +
            '</div>' +
            '<div class="m-lv-stop-body">' +
                '<div class="m-lv-stop-cust">' + _lvEsc(_lvName(s)) + '</div>' +
                '<div class="m-lv-stop-addr">' + _lvEsc(_lvAddr(s)) + '</div>' +
                '<div class="m-lv-stop-meta">#' + _lvEsc(s.bon_number || s.bon_id) +
                    (s.boxes ? ' &middot; ' + s.boxes + ' kasser' : '') + '</div>' +
                (badge ? '<div>' + badge + '</div>' : '') +
            '</div>' +
        '</div>'
    );
}

function _lvAttachListHandlers() {
    _lvContainer.querySelectorAll('[data-depart]').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            _lvDepart(Number(btn.dataset.depart));
        });
    });
    _lvContainer.querySelectorAll('[data-undo-depart]').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            _lvUndoDepart(Number(btn.dataset.undoDepart));
        });
    });
    _lvContainer.querySelectorAll('.m-lv-stop').forEach(function(el) {
        el.addEventListener('click', function() {
            var found = _lvFindStop(Number(el.dataset.stop));
            if (found) { _lvDetail = { routeId: found.route.id, stopId: found.stop.stop_id }; _lvRender(); }
        });
    });
}

async function _lvDepart(routeId) {
    try {
        await departDeliveryRoute(routeId);
        if (window._mToast) window._mToast('Tur startet — god tur!');
        await _lvLoad();
    } catch (e) {
        if (window._mToast) window._mToast('Kunne ikke starte turen');
    }
}

async function _lvUndoDepart(routeId) {
    if (!window.confirm('Fortryd start af turen?')) return;
    try {
        await undoDepartDeliveryRoute(routeId);
        if (window._mToast) window._mToast('Start fortrudt');
        await _lvLoad();
    } catch (e) {
        if (window._mToast) window._mToast((e && e.message) || 'Kunne ikke fortryde');
    }
}

/* ── Detalje — ét stop ─────────────────────────────────── */
function _lvRenderDetail(route, s) {
    var stops = route.stops || [];
    var idx = stops.findIndex(function(x) { return x.stop_id === s.stop_id; });
    var done = s.status !== 'planlagt';

    var contactName  = s.day_contact_name || _lvName(s);
    var contactPhone = s.day_contact_phone || s.customer_phone || '';

    var html = '';
    html += '<div class="m-lv-detail-head">' +
        '<button class="m-lv-back" id="lvBack">&#8249; Dagens tur</button>' +
        '<span class="m-lv-detail-pos">Stop ' + (idx + 1) + ' af ' + stops.length + '</span>' +
    '</div>';

    /* Adresse + naviger */
    html += '<div class="m-lv-card">' +
        '<div class="m-lv-addr-big">' + _lvEsc(_lvAddr(s)) + '</div>' +
        (s.delivery_notes ? '' : '') +
        '<a class="m-lv-nav-btn" id="lvNav" href="' + _lvMapsUrl(s) + '" target="_blank" rel="noopener">' +
            '&#128205; Naviger til kunden' +
        '</a>' +
    '</div>';

    /* Pickup-info: kasser + bon */
    html += '<div class="m-lv-pickup">' +
        '<div class="m-lv-pickup-boxes">' +
            '<div class="m-lv-pickup-num">' + (s.boxes || '–') + '</div>' +
            '<div class="m-lv-pickup-lbl">kasser</div>' +
        '</div>' +
        '<div class="m-lv-pickup-bon">' +
            '<div class="m-lv-pickup-bonlbl">Bon</div>' +
            '<div class="m-lv-pickup-bonnum">#' + _lvEsc(s.bon_number || s.bon_id) + '</div>' +
            '<div class="m-lv-pickup-cust">' + _lvEsc(_lvName(s)) + '</div>' +
        '</div>' +
    '</div>';

    /* Kontakt på dagen */
    if (contactName || contactPhone) {
        html += '<div class="m-lv-card m-lv-contact">' +
            '<div class="m-lv-contact-head">' +
                '<span class="m-lv-contact-lbl">Kontakt på dagen</span>' +
                '<span class="m-lv-contact-name">' + _lvEsc(contactName || '—') + '</span>' +
            '</div>';
        if (contactPhone) {
            html += '<div class="m-lv-contact-actions">' +
                '<a class="m-lv-contact-btn" href="tel:' + _lvEsc(contactPhone) + '">&#128222; Ring</a>' +
                '<a class="m-lv-contact-btn" href="sms:' + _lvEsc(contactPhone) + '">&#128172; SMS</a>' +
            '</div>' +
            '<div class="m-lv-contact-phone">' + _lvEsc(contactPhone) + '</div>';
        }
        html += '</div>';
    }

    /* Leveringsinstruks */
    if (s.delivery_notes) {
        html += '<div class="m-lv-notes">' +
            '<div class="m-lv-notes-lbl">&#9888; Leveringsinstruks</div>' +
            '<div>' + _lvEsc(s.delivery_notes) + '</div>' +
        '</div>';
    }

    /* Bon-info */
    html += '<div class="m-lv-card">' +
        '<div class="m-lv-info-row"><span>Leveres senest</span><strong>' + (_lvTime(s.delivery_time) || '—') + '</strong></div>' +
        '<div class="m-lv-info-row"><span>Pax / enheder</span><strong>' + (s.pax || 0) + '</strong></div>' +
        '<div class="m-lv-info-row"><span>Betaling</span><strong>' + _lvEsc(_lvPayment(s.payment_type)) + '</strong></div>' +
    '</div>';

    /* Indhold */
    if ((s.items || []).length) {
        html += '<div class="m-lv-card"><div class="m-lv-card-title">Indhold</div>';
        s.items.forEach(function(it) {
            html += '<div class="m-lv-item"><span class="m-lv-item-qty">' + it.quantity + '&times;</span>' +
                _lvEsc(it.product_name) + '</div>';
        });
        html += '</div>';
    }

    /* Problem-historik */
    if ((s.incidents || []).length) {
        html += '<div class="m-lv-card m-lv-inc-log"><div class="m-lv-card-title">Logget problem</div>';
        s.incidents.forEach(function(inc) {
            var def = _LV_INCIDENTS.find(function(d) { return d.type === inc.incident_type; });
            html += '<div class="m-lv-inc-row">' + (def ? def.label : inc.incident_type) +
                (inc.description ? ' — ' + _lvEsc(inc.description) : '') + '</div>';
        });
        html += '</div>';
    }

    /* Handlinger */
    if (done) {
        var label = s.status === 'leveret' ? '&#10004; Leveret' : '&#9888; Problem logget';
        html += '<div class="m-lv-actionbar"><div class="m-lv-done-state ' + s.status + '">' + label + '</div></div>';
    } else {
        html += '<div class="m-lv-actionbar">' +
            '<button class="m-lv-deliver" id="lvDeliver">&#10004; Marker som leveret</button>' +
            '<button class="m-lv-problem" id="lvProblem">&#9888; Problem</button>' +
        '</div>';
    }

    _lvContainer.innerHTML = html;

    var back = document.getElementById('lvBack');
    if (back) back.addEventListener('click', function() { _lvDetail = null; _lvRender(); });
    var deliver = document.getElementById('lvDeliver');
    if (deliver) deliver.addEventListener('click', function() { _lvMarkDelivered(s); });
    var problem = document.getElementById('lvProblem');
    if (problem) problem.addEventListener('click', function() {
        _lvProblem = { stop: s, route: route, step: 1, type: null, photo: null, note: '' };
        _lvRender();
    });
}

async function _lvMarkDelivered(s) {
    var btn = document.getElementById('lvDeliver');
    if (btn) { btn.disabled = true; btn.textContent = 'Gemmer...'; }
    var body = { status: 'leveret' };
    if (_lvGeo) { body.lat = _lvGeo.lat; body.lng = _lvGeo.lng; }
    try {
        await setDeliveryStopStatus(s.stop_id, body);
        if (window._mToast) window._mToast('Stop markeret som leveret');
        _lvDetail = null;
        await _lvLoad();
    } catch (e) {
        if (window._mToast) window._mToast('Kunne ikke gemme');
        if (btn) { btn.disabled = false; btn.innerHTML = '&#10004; Marker som leveret'; }
    }
}

/* ── Problem-flow (3 trin) ─────────────────────────────── */
function _lvRenderProblem() {
    var p = _lvProblem;
    var titles = { 1: 'Hvad skete der?', 2: 'Dokumentér', 3: 'Bekræft' };

    var bodyHtml = '';
    if (p.step === 1) {
        bodyHtml = '<div class="m-lv-types">';
        _LV_INCIDENTS.forEach(function(d) {
            bodyHtml += '<button class="m-lv-type' + (p.type === d.type ? ' selected' : '') +
                '" data-type="' + d.type + '">' +
                '<span class="m-lv-type-ico">' + d.icon + '</span>' +
                '<span class="m-lv-type-txt"><span class="m-lv-type-lbl">' + d.label + '</span>' +
                '<span class="m-lv-type-desc">' + d.desc + '</span></span>' +
            '</button>';
        });
        bodyHtml += '</div>';
    } else if (p.step === 2) {
        bodyHtml =
            '<label class="m-lv-photo' + (p.photo ? ' taken' : '') + '" id="lvPhotoArea">' +
                '<input type="file" accept="image/*" capture="environment" id="lvPhotoInput" hidden>' +
                '<span class="m-lv-photo-ico">' + (p.photo ? '&#10004;' : '&#128247;') + '</span>' +
                '<span class="m-lv-photo-lbl">' + (p.photo ? 'Billede valgt' : 'Tag billede') + '</span>' +
                '<span class="m-lv-photo-sub">' + (p.photo ? 'Tryk for at vælge nyt' : 'Anbefales — kan springes over') + '</span>' +
            '</label>' +
            (_lvGeo ? '<div class="m-lv-geo">&#128205; Position fanget</div>' : '') +
            '<label class="m-lv-note-lbl">Kort beskrivelse (valgfri)</label>' +
            '<textarea class="m-lv-note" id="lvNote" placeholder="F.eks. \'Stillet bag receptionen, vagt orienteret\'">' +
                _lvEsc(p.note || '') + '</textarea>';
    } else {
        var def = _LV_INCIDENTS.find(function(d) { return d.type === p.type; });
        bodyHtml = '<div class="m-lv-confirm">' +
            _lvConfirmRow('Stop', '#' + (p.stop.bon_number || p.stop.bon_id) + ' · ' + _lvName(p.stop)) +
            _lvConfirmRow('Type', def ? def.label : p.type) +
            _lvConfirmRow('Billede', p.photo ? 'Ja' : 'Nej') +
            _lvConfirmRow('Position', _lvGeo ? 'Fanget' : 'Ikke tilgængelig') +
            _lvConfirmRow('Note', p.note ? p.note : '—') +
        '</div>' +
        '<div class="m-lv-confirm-hint">Kontoret får besked. Stoppet markeres som <strong>problem</strong>.</div>';
    }

    var nextLabel = p.step === 3 ? 'Send & marker stop' : 'Næste';
    var nextDisabled = (p.step === 1 && !p.type);

    _lvContainer.innerHTML =
        '<div class="m-lv-modal">' +
            '<div class="m-lv-modal-head">' +
                '<span class="m-lv-modal-title">' + titles[p.step] + '</span>' +
                '<span class="m-lv-modal-step">' + p.step + '/3</span>' +
            '</div>' +
            '<div class="m-lv-modal-body">' + bodyHtml + '</div>' +
            '<div class="m-lv-modal-actions">' +
                '<button class="m-lv-modal-cancel" id="lvPBack">' +
                    (p.step === 1 ? 'Annullér' : 'Tilbage') + '</button>' +
                '<button class="m-lv-modal-next" id="lvPNext"' + (nextDisabled ? ' disabled' : '') + '>' +
                    nextLabel + '</button>' +
            '</div>' +
        '</div>';

    _lvAttachProblemHandlers();
}

function _lvConfirmRow(label, value) {
    return '<div class="m-lv-confirm-row">' +
        '<span class="m-lv-confirm-lbl">' + label + '</span>' +
        '<span class="m-lv-confirm-val">' + _lvEsc(value) + '</span>' +
    '</div>';
}

function _lvAttachProblemHandlers() {
    var p = _lvProblem;

    _lvContainer.querySelectorAll('.m-lv-type').forEach(function(btn) {
        btn.addEventListener('click', function() {
            p.type = btn.dataset.type;
            _lvRenderProblem();
        });
    });

    var photoArea = document.getElementById('lvPhotoArea');
    var photoInput = document.getElementById('lvPhotoInput');
    if (photoInput) {
        photoInput.addEventListener('change', function() {
            if (photoInput.files && photoInput.files[0]) {
                p.photo = photoInput.files[0];
                _lvRenderProblem();
            }
        });
    }

    var note = document.getElementById('lvNote');
    if (note) note.addEventListener('input', function() { p.note = note.value; });

    var back = document.getElementById('lvPBack');
    if (back) back.addEventListener('click', function() {
        if (p.step === 1) { _lvProblem = null; _lvRender(); }
        else { p.step -= 1; _lvRenderProblem(); }
    });

    var next = document.getElementById('lvPNext');
    if (next) next.addEventListener('click', function() {
        if (p.step < 3) {
            // Note kan ligge ugemt i textarea hvis input-event ikke nåede at fyre.
            var n = document.getElementById('lvNote');
            if (n) p.note = n.value;
            p.step += 1;
            _lvRenderProblem();
        } else {
            _lvSubmitProblem();
        }
    });
}

async function _lvSubmitProblem() {
    var p = _lvProblem;
    var next = document.getElementById('lvPNext');
    if (next) { next.disabled = true; next.textContent = 'Sender...'; }
    var payload = {
        bon_id: p.stop.bon_id,
        route_stop_id: p.stop.stop_id,
        incident_type: p.type,
        description: p.note || '',
    };
    if (_lvGeo) { payload.location_lat = _lvGeo.lat; payload.location_lng = _lvGeo.lng; }
    if (p.photo) payload.photo = p.photo;
    try {
        await logDeliveryIncident(payload);
        if (window._mToast) window._mToast('Problem logget');
        _lvProblem = null;
        _lvDetail = null;
        await _lvLoad();
    } catch (e) {
        if (window._mToast) window._mToast('Kunne ikke sende — prøv igen');
        if (next) { next.disabled = false; next.textContent = 'Send & marker stop'; }
    }
}

/* ── Helpers ───────────────────────────────────────────── */
function _lvName(s) {
    return s.company_name || s.customer_name || ('Bon ' + (s.bon_number || s.bon_id));
}

function _lvAddr(s) {
    var parts = [];
    if (s.street_name) parts.push(s.street_name + (s.street_nr ? ' ' + s.street_nr : ''));
    var city = [s.postal_code, s.city].filter(Boolean).join(' ');
    if (city) parts.push(city);
    return parts.join(', ') || 'Adresse mangler';
}

function _lvMapsUrl(s) {
    if (s.lat != null && s.lon != null) {
        return 'https://www.google.com/maps/dir/?api=1&destination=' + s.lat + ',' + s.lon;
    }
    return 'https://www.google.com/maps/dir/?api=1&destination=' +
        encodeURIComponent(_lvAddr(s));
}

function _lvVehicleIcon(type) {
    if (type === 'volvo') return '&#128666;';
    if (type === 'bike' || type === 'own-bike') return '&#128692;';
    if (type === 'taxi') return '&#128661;';
    return '&#128230;';
}

function _lvPayment(pt) {
    var map = { invoice: 'Faktura', card: 'Kort', mobilepay: 'MobilePay', cash: 'Kontant', pos: 'POS' };
    return map[pt] || (pt || '—');
}

function _lvTime(t) {
    return t ? String(t).slice(0, 5) : '';
}

function _lvDur(min) {
    min = Math.round(min);
    if (min < 60) return min + ' min';
    var h = Math.floor(min / 60), m = min % 60;
    return h + 't' + (m ? ' ' + m + 'min' : '');
}

function _lvEsc(str) {
    if (str == null) return '';
    var d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
}
