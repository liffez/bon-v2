/**
 * office/views/logistik-historik.js
 * ════════════════════════════════════════════════════════════
 * Logistik — Historik: alle leveringer i en periode plottet på kort.
 *
 * Overblik/analyse — adskilt fra den daglige leveringsoversigt.
 * Punkt-mode (vogn-farvede markører, klik → bon-info) eller heatmap.
 *
 * API:
 *   initLogistikHistory(containerEl, opts)
 *   cleanupLogistikHistory()
 *
 * Afhængigheder: shared/api.js → fetchDeliveryHistoryMap · Leaflet + leaflet-heat
 * ════════════════════════════════════════════════════════════
 */

/* ── State ──────────────────────────────────────────────── */
var _lhContainer = null;
var _lhActive    = false;
var _lhData      = null;
var _lhMap       = null;
var _lhPointLayer = null;
var _lhHeatLayer  = null;
var _lhMode      = 'points';     // 'points' | 'heat'
var _lhFrom      = '';
var _lhTo        = '';
var _lhMethod    = '';

/* ── Helpers ────────────────────────────────────────────── */
function _lhEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) {
        return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c];
    });
}
function _lhToday() { return todayISO(); }
function _lhMonthsAgo(n) {
    // Måneds-aritmetik på den danske kalenderdato, UTC-forankret så
    // resultatet ikke afhænger af hvornår på døgnet det kaldes.
    var p = todayISO().split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1 - n, p[2]));
    return d.toISOString().slice(0, 10);   // utc-ok: UTC-forankret aritmetik
}
function _lhMethodColor(m) {
    return m === 'taxi' ? '#4a8a3a'
        : m === 'volvo' ? '#8e631f'
        : m === 'bike' ? '#2d6da3' : '#9a948c';
}

/* ── Init / Cleanup ─────────────────────────────────────── */
function initLogistikHistory(containerEl, opts) {
    _lhContainer = containerEl;
    _lhActive = true;
    _lhMode = 'points';
    _lhFrom = _lhMonthsAgo(6);
    _lhTo = _lhToday();
    _lhMethod = '';

    _lhRenderShell();
    _lhInitMap();
    _lhLoad();
}

function cleanupLogistikHistory() {
    _lhActive = false;
    _lhData = null;
    if (_lhMap) { try { _lhMap.remove(); } catch (e) {} _lhMap = null; }
    _lhPointLayer = null;
    _lhHeatLayer = null;
}

/* ── Shell ──────────────────────────────────────────────── */
function _lhRenderShell() {
    _lhContainer.innerHTML =
        '<div class="lh-wrap">' +
          '<div class="lh-bar">' +
            '<label class="lh-bar-label">Fra</label>' +
            '<input type="date" id="lhFrom" class="lh-date" value="' + _lhFrom + '">' +
            '<label class="lh-bar-label">Til</label>' +
            '<input type="date" id="lhTo" class="lh-date" value="' + _lhTo + '">' +
            '<select id="lhMethod" class="lh-select">' +
              '<option value="">Alle vogne</option>' +
              '<option value="bike">Cykel</option>' +
              '<option value="taxi">Taxa</option>' +
              '<option value="volvo">Volvo</option>' +
            '</select>' +
            '<div class="lh-mode" id="lhMode">' +
              '<button data-mode="points" class="active">Punkter</button>' +
              '<button data-mode="heat">Heatmap</button>' +
            '</div>' +
            '<span class="lh-stats" id="lhStats"></span>' +
          '</div>' +
          '<div class="lh-map" id="lhMap"></div>' +
        '</div>';

    document.getElementById('lhFrom').addEventListener('change', function(e) {
        _lhFrom = e.target.value; _lhLoad();
    });
    document.getElementById('lhTo').addEventListener('change', function(e) {
        _lhTo = e.target.value; _lhLoad();
    });
    document.getElementById('lhMethod').addEventListener('change', function(e) {
        _lhMethod = e.target.value; _lhLoad();
    });
    document.getElementById('lhMode').addEventListener('click', function(e) {
        var mode = e.target.getAttribute('data-mode');
        if (!mode || mode === _lhMode) return;
        _lhMode = mode;
        _lhContainer.querySelectorAll('#lhMode button').forEach(function(b) {
            b.classList.toggle('active', b.getAttribute('data-mode') === mode);
        });
        _lhRender(false);
    });
}

function _lhInitMap() {
    if (typeof L === 'undefined') return;
    var el = document.getElementById('lhMap');
    if (!el) return;
    _lhMap = L.map(el, { zoomControl: true }).setView([55.69, 12.56], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '© OpenStreetMap'
    }).addTo(_lhMap);
    _lhPointLayer = L.layerGroup().addTo(_lhMap);
    setTimeout(function() { if (_lhMap) _lhMap.invalidateSize(); }, 150);
}

/* ── Data ───────────────────────────────────────────────── */
function _lhLoad() {
    if (!_lhFrom || !_lhTo) return;
    var stats = document.getElementById('lhStats');
    if (stats) stats.textContent = 'Henter…';
    fetchDeliveryHistoryMap(_lhFrom, _lhTo, _lhMethod)
        .then(function(resp) {
            if (!_lhActive) return;
            _lhData = resp;
            _lhRender(true);
            _lhRenderStats();
        })
        .catch(function(err) {
            console.error('[logistik-historik] load error:', err);
            if (stats) stats.textContent = 'Kunne ikke hente data';
        });
}

function _lhRenderStats() {
    var el = document.getElementById('lhStats');
    if (!el || !_lhData) return;
    var bm = _lhData.by_method || {};
    var parts = [_lhData.total + ' leveringer'];
    if (bm.bike)  parts.push(bm.bike + ' cykel');
    if (bm.taxi)  parts.push(bm.taxi + ' taxa');
    if (bm.volvo) parts.push(bm.volvo + ' volvo');
    el.textContent = parts.join(' · ');
}

function _lhPopup(p) {
    return '<div class="lh-popup">' +
        '<strong>#' + _lhEsc(p.bon_number) + '</strong> · ' + _lhEsc(p.delivery_date) +
        '<br>' + _lhEsc(p.company_name || p.customer_name || 'Ukendt') +
        '<br>' + _lhEsc([p.postal_code, p.city].filter(Boolean).join(' ')) +
        (p.vehicle_label ? '<br>🚚 ' + _lhEsc(p.vehicle_label) : '') +
        (p.total_units ? ' · ' + p.total_units + ' enh.' : '') +
        '</div>';
}

/* ── Render ─────────────────────────────────────────────── */
function _lhRender(fit) {
    if (!_lhMap || !_lhPointLayer) return;
    _lhPointLayer.clearLayers();
    if (_lhHeatLayer) { _lhMap.removeLayer(_lhHeatLayer); _lhHeatLayer = null; }

    var pts = (_lhData && _lhData.points) || [];
    var bounds = [];

    if (_lhMode === 'heat') {
        var heatPts = pts.map(function(p) { return [p.lat, p.lon]; });
        if (heatPts.length && typeof L.heatLayer === 'function') {
            _lhHeatLayer = L.heatLayer(heatPts, {
                radius: 26, blur: 20, maxZoom: 14
            }).addTo(_lhMap);
        }
        pts.forEach(function(p) { bounds.push([p.lat, p.lon]); });
    } else {
        pts.forEach(function(p) {
            var color = p.vehicle_color || _lhMethodColor(p.delivery_method);
            var m = L.circleMarker([p.lat, p.lon], {
                radius: 6, color: '#fff', weight: 1.5,
                fillColor: color, fillOpacity: 0.85
            });
            m.bindPopup(_lhPopup(p));
            m.addTo(_lhPointLayer);
            bounds.push([p.lat, p.lon]);
        });
    }

    if (fit && bounds.length) {
        _lhMap.fitBounds(bounds, { padding: [32, 32], maxZoom: 14 });
    }
}
