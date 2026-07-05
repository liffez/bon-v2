/* ══════════════════════════════════════════════════════════════
   CO₂ kg-vej — vej tælle-varer (emballage + flaskedrikke)
   Spec: docs/CLAUDE_CO2.md §3/§4 (F2b, vejnings-del).

   Lister råvarer der bruges i opskrifter, har en TÆLLE-enhed som stock
   (Antal/Flaske/…) og mangler en vej til kg. Bruger vejer "N stk → Y gram"
   → opretter en <stock>→Kilo QU-konvertering. Vægten deles med kostpris (§5).
   Væsker (Liter) håndteres af co2-f2b-densities.js, ikke her.
   ══════════════════════════════════════════════════════════════ */

var _cvInjected = false;
var _cv = { KILO: 4, items: [], quName: {}, groupName: {}, done: 0 };

function _cvInjectStyle() {
    if (_cvInjected) return;
    _cvInjected = true;
    var css =
        '.cv-wrap{padding:20px 24px;max-width:760px}' +
        '.cv-head{margin-bottom:14px}' +
        '.cv-title{font-size:20px;font-weight:700;color:var(--color-text)}' +
        '.cv-sub{font-size:13px;color:var(--color-text-dim);margin-top:4px;line-height:1.5}' +
        '.cv-progress{margin:10px 0 18px;font-size:14px;font-weight:700;color:var(--brand-primary)}' +
        '.cv-group-h{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;' +
            'color:var(--color-text-dim);margin:18px 0 8px}' +
        '.cv-row{background:var(--color-surface);border:1px solid var(--color-border);border-radius:10px;' +
            'padding:12px 14px;margin-bottom:8px;display:flex;flex-wrap:wrap;align-items:center;gap:10px}' +
        '.cv-name{flex:1 1 180px;font-weight:700;font-size:15px}' +
        '.cv-inputs{display:flex;align-items:center;gap:6px;font-size:14px;color:var(--color-text-dim)}' +
        '.cv-inputs input{width:64px;padding:8px;border:1.5px solid var(--color-border);border-radius:8px;' +
            'font-size:16px;text-align:center}' +
        '.cv-inputs input.cv-g{width:84px}' +
        '.cv-inputs input.cv-emb{width:64px}' +
        '.cv-preview{flex:1 1 130px;font-size:12px;color:var(--color-text-dim)}' +
        '.cv-save{padding:9px 16px;border:none;border-radius:8px;background:var(--brand-primary);color:#fff;' +
            'font-weight:700;font-size:14px;cursor:pointer}' +
        '.cv-save:disabled{opacity:.4;cursor:default}' +
        '.cv-row.done{background:#eef7ee;border-color:#bcdcbc}' +
        '.cv-row.done .cv-preview{color:#3a7a3a;font-weight:700}' +
        '.cv-empty{padding:30px;text-align:center;color:var(--color-text-dim)}';
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
}

function _cvIsWeight(name) { return ['kilo','kg','kilogram','gram','g'].indexOf(String(name||'').toLowerCase()) !== -1; }
function _cvIsVolume(name) { return ['liter','l','ml','milliliter'].indexOf(String(name||'').toLowerCase()) !== -1; }

async function initCo2Veje(container) {
    _cvInjectStyle();
    container.innerHTML = '<div class="cv-wrap"><div class="cv-empty">Henter varer…</div></div>';
    try {
        var res = await Promise.all([
            fetchGrocyProducts(),
            fetchGrocyRecipesPos(),
            fetchGrocyQuantityUnitConversions(),
            fetchGrocyQuantityUnits(),
            fetchGrocyProductGroups()
        ]);
        _cvBuild(container, res[0], res[1], res[2], res[3], res[4]);
    } catch (e) {
        container.innerHTML = '<div class="cv-wrap"><div class="cv-empty">Kunne ikke hente data: ' +
            (e && e.message ? e.message : e) + '</div></div>';
    }
}

function _cvBuild(container, products, pos, conv, units, groups) {
    _cv.quName = {}; units.forEach(function(u){ _cv.quName[u.id] = u.name; });
    _cv.groupName = {}; (groups||[]).forEach(function(g){ _cv.groupName[g.id] = g.name; });
    // Find Kilo-id
    var kilo = units.find(function(u){ return _cvIsWeight(u.name) && String(u.name).toLowerCase().indexOf('gram') === -1; });
    _cv.KILO = kilo ? kilo.id : 4;

    var used = {}; pos.forEach(function(p){ if (p.product_id) used[parseInt(p.product_id)] = true; });
    // produkt-id'er der allerede har en stock→kg/gram konvertering
    var hasKg = {};
    conv.forEach(function(c){
        if (!c.product_id) return;
        var toName = (_cv.quName[parseInt(c.to_qu_id)] || '').toLowerCase();
        if (toName === 'kilo' || toName === 'gram') {
            (hasKg[parseInt(c.product_id)] = hasKg[parseInt(c.product_id)] || {})[parseInt(c.from_qu_id)] = true;
        }
    });

    var items = [];
    products.forEach(function(p){
        var pid = parseInt(p.id);
        if (!used[pid]) return;
        var stockName = _cv.quName[parseInt(p.qu_id_stock)] || '';
        if (_cvIsWeight(stockName) || _cvIsVolume(stockName)) return; // kun tælle-varer
        var already = hasKg[pid] && hasKg[pid][parseInt(p.qu_id_stock)];
        if (already) return;
        items.push({ id: pid, name: p.name, stockQu: parseInt(p.qu_id_stock),
                     stockName: stockName, group: _cv.groupName[p.product_group_id] || 'Andet' });
    });
    items.sort(function(a,b){ return (a.group+a.name).localeCompare(b.group+b.name, 'da'); });
    _cv.items = items;
    _cv.done = 0;
    _cvRender(container);
}

function _cvRender(container) {
    var items = _cv.items;
    var total = items.length + _cv.done;
    var html = '<div class="cv-wrap">' +
        '<div class="cv-head">' +
            '<div class="cv-title">CO₂ kg-vej — vej tælle-varer</div>' +
            '<div class="cv-sub">Vej flere stk ad gangen (fx 10 servietter) for præcision. ' +
            'Vægten pr. stk bruges til CO₂ + kostpris. Væsker håndteres separat.</div>' +
        '</div>' +
        '<div class="cv-progress">' + _cv.done + ' af ' + total + ' vejet</div>';

    if (!items.length) {
        html += '<div class="cv-empty">🎉 Alle tælle-varer har en kg-vej.</div></div>';
        container.innerHTML = html;
        return;
    }

    var lastGroup = null;
    items.forEach(function(it){
        if (it.group !== lastGroup) { html += '<div class="cv-group-h">' + _cvEsc(it.group) + '</div>'; lastGroup = it.group; }
        html += '<div class="cv-row" data-id="' + it.id + '" data-qu="' + it.stockQu + '">' +
            '<div class="cv-name">' + _cvEsc(it.name) + ' <span style="font-weight:400;color:var(--color-text-dim)">(' + _cvEsc(it.stockName) + ')</span></div>' +
            '<div class="cv-inputs">Vej <input type="number" class="cv-n" min="1" step="1" value="1"> stk → ' +
                '<input type="number" class="cv-g" min="0" step="any" placeholder="gram"> g' +
                ' · emballage/stk <input type="number" class="cv-emb" min="0" step="any" value="0" title="Beholder pr. stk (fx dåse/flaske) — 0 hvis ingen"> g</div>' +
            '<div class="cv-preview"></div>' +
            '<button class="cv-save" disabled>Gem</button>' +
        '</div>';
    });
    html += '</div>';
    container.innerHTML = html;

    container.querySelectorAll('.cv-row').forEach(function(row){ _cvWireRow(row, container); });
}

function _cvWireRow(row, container) {
    var nEl = row.querySelector('.cv-n');
    var gEl = row.querySelector('.cv-g');
    var embEl = row.querySelector('.cv-emb');
    var prev = row.querySelector('.cv-preview');
    var btn = row.querySelector('.cv-save');
    function upd() {
        var n = parseFloat(nEl.value) || 1;
        var g = parseFloat(gEl.value);
        var emb = parseFloat(embEl.value) || 0;
        if (!g || g <= 0 || n <= 0) { prev.textContent = ''; btn.disabled = true; return; }
        var perG = g / n, perKg = perG / 1000;
        var netG = perG - emb;
        var txt = '1 stk ≈ ' + (Math.round(perG*100)/100) + ' g = ' + (Math.round(perKg*100000)/100000) + ' kg';
        if (emb > 0) txt += '  ·  netto ' + (Math.round(netG*100)/100) + ' g (emballage ' + emb + ' g)';
        prev.textContent = txt;
        btn.disabled = (emb > 0 && netG <= 0);
    }
    nEl.addEventListener('input', upd);
    gEl.addEventListener('input', upd);
    embEl.addEventListener('input', upd);
    btn.addEventListener('click', function(){ _cvSave(row, container, btn); });
}

async function _cvSave(row, container, btn) {
    var id = parseInt(row.dataset.id);
    var qu = parseInt(row.dataset.qu);
    var n = parseFloat(row.querySelector('.cv-n').value) || 1;
    var g = parseFloat(row.querySelector('.cv-g').value);
    var emb = parseFloat(row.querySelector('.cv-emb').value) || 0;
    if (!g || g <= 0) return;
    var kgPerStk = (g / n) / 1000;
    btn.disabled = true; btn.textContent = 'Gemmer…';
    try {
        await postGrocyQuConversion({ product_id: id, from_qu_id: qu, to_qu_id: _cv.KILO, factor: kgPerStk });
        // Emballage-vægt pr. stk (gram) — gemmes altid, så 0 markerer "tjekket, ingen emballage"
        try {
            await putGrocyProductUserfields(id, { co2e_packaging_g: emb });
        } catch (ufErr) {
            row.querySelector('.cv-preview').textContent = '⚠ kg-vej gemt, men emballage-felt fejlede: ' + (ufErr && ufErr.message ? ufErr.message : ufErr);
        }
        row.classList.add('done');
        if (!row.querySelector('.cv-preview').textContent.startsWith('⚠')) {
            row.querySelector('.cv-preview').textContent = '✓ Gemt: 1 stk = ' + (Math.round(kgPerStk*100000)/100000) + ' kg' + (emb > 0 ? ' (emb. ' + emb + ' g)' : '');
        }
        btn.style.display = 'none';
        // fjern fra items, bump done, opdater progress-tæller
        _cv.items = _cv.items.filter(function(x){ return x.id !== id; });
        _cv.done++;
        var prog = container.querySelector('.cv-progress');
        if (prog) prog.textContent = _cv.done + ' af ' + (_cv.items.length + _cv.done) + ' vejet';
    } catch (e) {
        btn.disabled = false; btn.textContent = 'Gem';
        alert('Kunne ikke gemme: ' + (e && e.message ? e.message : e));
    }
}

function _cvEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
        return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c];
    });
}
