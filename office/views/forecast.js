/**
 * office/views/forecast.js — Leverandør-forecast (#165)
 * ════════════════════════════════════════════════════════════
 * Forventet råvarebehov i en fremtidig periode, grupperet per leverandør,
 * som en liste man kan kopiere/maile til leverandøren som et heads-up.
 *
 * Model: SÆSON (samme periode sidste år) som primært signal, rullende
 * 8-ugers snit som fallback, allerede-bookede bons lagt ovenpå
 * (forecast = max(sæson, booket)). Backend: GET /api/purchasing/forecast.
 *
 * Mounts via office/index.html → indkob-forecast-view. Entry: initForecast(el).
 */

let _fcState = { from: null, to: null, data: null, loading: false };
let _fcEl = null;

function _fcISO(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function _fcAddDays(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return _fcISO(d);
}
function _fcEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function _fcNum(n) {
  return Number(n || 0).toLocaleString('da-DK', { maximumFractionDigits: 1 });
}
function _fcFmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return d + '/' + m + ' ' + y;
}

function _fcEnsureStyle() {
  if (document.getElementById('fc-style')) return;
  const s = document.createElement('style');
  s.id = 'fc-style';
  s.textContent = `
    .fc-wrap { padding: 16px 20px 60px; max-width: 1100px; }
    .fc-controls { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap;
      background: var(--color-surface, #fff); border: 1px solid var(--color-border, #d7d1ca);
      border-radius: 10px; padding: 14px 16px; margin-bottom: 16px; }
    .fc-field { display: flex; flex-direction: column; gap: 3px; }
    .fc-field label { font-size: 12px; color: var(--color-text-dim, #7a736a); font-weight: 600; }
    .fc-field input { padding: 7px 9px; border: 1px solid var(--color-border, #d7d1ca);
      border-radius: 6px; font: inherit; }
    .fc-quick { display: flex; gap: 6px; }
    .fc-btn { padding: 7px 12px; border: 1px solid var(--color-border, #d7d1ca);
      background: var(--color-surface, #fff); border-radius: 6px; cursor: pointer; font: inherit; }
    .fc-btn:hover { background: var(--brand-primary-light, #f1e6b2); }
    .fc-btn.primary { background: var(--brand-primary, #8e631f); color: #fff; border-color: var(--brand-primary, #8e631f); }
    .fc-meta { font-size: 13px; color: var(--color-text-dim, #7a736a); margin-bottom: 14px; line-height: 1.6; }
    .fc-fallback { background: #fdf3e0; border: 1px solid #e8c98a; border-radius: 6px;
      padding: 8px 12px; margin-bottom: 14px; font-size: 13px; color: #7a5a1e; }
    .fc-sup { border: 1px solid var(--color-border, #d7d1ca); border-radius: 10px;
      margin-bottom: 14px; overflow: hidden; background: var(--color-surface, #fff); }
    .fc-sup-head { display: flex; align-items: center; justify-content: space-between;
      gap: 10px; padding: 11px 16px; background: var(--brand-primary-light, #f1e6b2);
      border-bottom: 1px solid var(--color-border, #d7d1ca); }
    .fc-sup-name { font-weight: 700; font-size: 15px; }
    .fc-sup-count { font-size: 12px; color: var(--color-text-dim, #7a736a); font-weight: 400; }
    .fc-sup-actions { display: flex; gap: 6px; }
    .fc-none .fc-sup-head { background: #efece8; }
    .fc-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .fc-table th, .fc-table td { text-align: left; padding: 6px 16px; border-top: 1px solid var(--color-border, #ece7e0); }
    .fc-table th { font-size: 11px; text-transform: uppercase; letter-spacing: .3px;
      color: var(--color-text-dim, #7a736a); font-weight: 700; }
    .fc-table td.num, .fc-table th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .fc-fc { font-weight: 700; }
    .fc-sub { color: var(--color-text-dim, #9a938a); }
    .fc-empty { padding: 40px; text-align: center; color: var(--color-text-dim, #7a736a); }
    .fc-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: #333; color: #fff; padding: 9px 16px; border-radius: 8px; font-size: 13px;
      z-index: 9999; opacity: 0; transition: opacity .2s; }
    .fc-toast.show { opacity: 1; }
  `;
  document.head.appendChild(s);
}

function _fcToast(msg) {
  let t = document.querySelector('.fc-toast');
  if (!t) { t = document.createElement('div'); t.className = 'fc-toast'; document.body.appendChild(t); }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(t._to);
  t._to = setTimeout(() => t.classList.remove('show'), 1800);
}

function initForecast(el) {
  _fcEl = el;
  _fcEnsureStyle();
  const today = _fcISO(new Date());
  if (!_fcState.from) { _fcState.from = today; _fcState.to = _fcAddDays(today, 27); }
  el.innerHTML = `
    <div class="fc-wrap">
      <div class="fc-controls">
        <div class="fc-field"><label>Fra</label><input type="date" id="fcFrom" value="${_fcState.from}"></div>
        <div class="fc-field"><label>Til</label><input type="date" id="fcTo" value="${_fcState.to}"></div>
        <div class="fc-quick">
          <button class="fc-btn" data-fc-weeks="4">4 uger</button>
          <button class="fc-btn" data-fc-weeks="8">8 uger</button>
        </div>
        <button class="fc-btn primary" id="fcRun">Beregn forecast</button>
      </div>
      <div id="fcResults"><div class="fc-empty">Vælg en periode og tryk “Beregn forecast”.</div></div>
    </div>`;

  el.querySelector('#fcRun').addEventListener('click', () => {
    _fcState.from = el.querySelector('#fcFrom').value;
    _fcState.to = el.querySelector('#fcTo').value;
    _fcLoad();
  });
  el.querySelectorAll('[data-fc-weeks]').forEach((b) => b.addEventListener('click', () => {
    const from = el.querySelector('#fcFrom').value || _fcISO(new Date());
    const to = _fcAddDays(from, parseInt(b.dataset.fcWeeks) * 7 - 1);
    el.querySelector('#fcTo').value = to;
    _fcState.from = from; _fcState.to = to;
    _fcLoad();
  }));

  el.addEventListener('click', _fcOnCopy);
  _fcLoad();
}

function cleanupForecast() {
  if (_fcEl) _fcEl.removeEventListener('click', _fcOnCopy);
  _fcEl = null;
}

async function _fcLoad() {
  const box = document.getElementById('fcResults');
  if (!box) return;
  box.innerHTML = '<div class="fc-empty">Beregner forecast … (opløser opskrifter mod Grocy)</div>';
  try {
    const q = `from=${encodeURIComponent(_fcState.from)}&to=${encodeURIComponent(_fcState.to)}`;
    _fcState.data = await apiFetch('/purchasing/forecast?' + q);
    _fcRender();
  } catch (e) {
    box.innerHTML = `<div class="fc-empty">Kunne ikke hente forecast: ${_fcEsc(e.message || e)}</div>`;
  }
}

function _fcRender() {
  const box = document.getElementById('fcResults');
  const d = _fcState.data;
  if (!box || !d) return;

  const histLabel = d.used_fallback
    ? `rullende 8-ugers snit (${_fcFmtDate(d.fallback.trail_from)}–${_fcFmtDate(d.fallback.trail_to)}, ${d.fallback.trail_bon_count} bons)`
    : `samme periode sidste år (${_fcFmtDate(d.seasonal_from)}–${_fcFmtDate(d.seasonal_to)}, ${d.seasonal_bon_count} bons)`;

  let h = `<div class="fc-meta">
      Periode <strong>${_fcFmtDate(d.from)}–${_fcFmtDate(d.to)}</strong> ·
      historisk signal: ${histLabel} · allerede booket: ${d.booked_bon_count} bons.<br>
      <span class="fc-sub">Forecast = det største af historisk forventning og allerede-booket behov. Alt er cirka-tal — juster inden du melder ud.</span>
    </div>`;

  if (d.used_fallback) {
    h += `<div class="fc-fallback">⚠ For få bons i samme periode sidste år — bruger rullende 8-ugers snit som grundlag i stedet.</div>`;
  }

  if (!d.suppliers.length) {
    h += `<div class="fc-empty">Intet forventet behov i perioden.</div>`;
    box.innerHTML = h;
    return;
  }

  d.suppliers.forEach((sup, i) => {
    const noneCls = sup.supplier_id === null ? ' fc-none' : '';
    const canMail = sup.supplier_id !== null;
    h += `<div class="fc-sup${noneCls}">
      <div class="fc-sup-head">
        <div class="fc-sup-name">${_fcEsc(sup.supplier_name)} <span class="fc-sup-count">· ${sup.items.length} varer</span></div>
        <div class="fc-sup-actions">
          <button class="fc-btn" data-fc-copy="${i}">📋 Kopiér liste</button>
          ${canMail ? `<button class="fc-btn" data-fc-mail="${sup.supplier_id}">✉ Skriv til leverandør</button>` : ''}
        </div>
      </div>
      <table class="fc-table">
        <thead><tr>
          <th>Vare</th>
          <th class="num">Forecast</th>
          <th class="num">Sæson</th>
          <th class="num">Booket</th>
        </tr></thead>
        <tbody>
          ${sup.items.map((it) => `<tr>
            <td>${_fcEsc(it.product_name)}</td>
            <td class="num fc-fc">${_fcNum(it.forecast_qty)} ${_fcEsc(it.unit || '')}</td>
            <td class="num fc-sub">${_fcNum(it.historic_qty)}</td>
            <td class="num fc-sub">${_fcNum(it.booked_qty)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  });

  box.innerHTML = h;
}

function _fcCopyText(text, supName) {
  const done = () => _fcToast('Kopieret — klar til at maile ' + supName);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => _fcCopyFallback(text));
  } else {
    _fcCopyFallback(text);
  }
}
// Fallback når clipboard API ikke er tilgængelig (manglende fokus/gesture).
// Konvention (jf. delivery-popout): ingen execCommand — vis en pre-selecteret
// textarea og lad brugeren trykke Cmd/Ctrl+C, luk på blur/Escape.
function _fcCopyFallback(text) {
  const prev = document.querySelector('.fc-copy-fallback');
  if (prev) prev.remove();
  const ta = document.createElement('textarea');
  ta.className = 'fc-copy-fallback';
  ta.value = text;
  ta.readOnly = true;
  ta.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
    'width:min(560px,80vw);height:40vh;z-index:99999;padding:12px;border-radius:8px;' +
    'border:2px solid var(--brand-primary,#8e631f);box-shadow:0 8px 30px rgba(0,0,0,.3)';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  _fcToast('Tryk Cmd/Ctrl+C for at kopiere — klik væk for at lukke');
  const close = () => { ta.removeEventListener('blur', close); ta.remove(); };
  ta.addEventListener('blur', close);
  ta.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(); });
}

function _fcOnCopy(e) {
  const copyBtn = e.target.closest('[data-fc-copy]');
  if (copyBtn) {
    const sup = _fcState.data.suppliers[parseInt(copyBtn.dataset.fcCopy)];
    if (!sup) return;
    const d = _fcState.data;
    const lines = [`Forecast ${_fcFmtDate(d.from)}–${_fcFmtDate(d.to)} — ${sup.supplier_name}:`, ''];
    sup.items.forEach((it) => lines.push(`- ${_fcNum(it.forecast_qty)} ${it.unit || ''} ${it.product_name}`.trim()));
    _fcCopyText(lines.join('\n'), sup.supplier_name);
    return;
  }
  const mailBtn = e.target.closest('[data-fc-mail]');
  if (mailBtn) {
    // Deep-link til Indkøb → leverandørpost, hvor mail-panelet åbner for leverandøren.
    // Listen ligger allerede i clipboard hvis brugeren kopierede først.
    const sid = mailBtn.dataset.fcMail;
    if (typeof switchView === 'function') switchView('indkob', 'post');
    location.hash = '';
    _fcToast('Åbn leverandøren i Leverandørpost og indsæt listen (kopiér den først)');
    // Brug samme URL-konvention som indkob's ?supplier_mail=
    try {
      const u = new URL(location.href);
      u.searchParams.set('supplier_mail', sid);
      history.replaceState(null, '', u);
    } catch (_) {}
  }
}

window.initForecast = initForecast;
window.cleanupForecast = cleanupForecast;
