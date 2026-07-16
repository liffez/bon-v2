// scripts/generate-opret-helper.js
// ==========================================
// Genererer en HTML-side med alle ukoblede Hørkram-favoritter,
// klar til at klikke igennem og oprette som nye Grocy-produkter.
//
// Læser data/horkram-status.json (output fra horkram-favorit-status.js).
// Hver vare får et "Opret i Grocy →"-link der åbner kitchen/stock.html?tab=create&barcode=<varenr>
// (Hørkram-lookup pre-fylder navn/pris/salgsenhed automatisk).
//
// Progress-tracking i localStorage så du kan se hvor langt du er kommet.
//
// Brug:
//   node scripts/generate-opret-helper.js                           # default base=relative
//   node scripts/generate-opret-helper.js --base https://bon.ristetrug.dk
//   node scripts/generate-opret-helper.js --in data/horkram-status.json --out data/horkram-opret-helper.html
// ==========================================

'use strict';

const path = require('path');
const fs   = require('fs');

const args = process.argv.slice(2);
const arg = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : def;
};

const INPUT  = arg('--in',  path.join(__dirname, '..', 'data', 'horkram-status.json'));
const OUTPUT = arg('--out', path.join(__dirname, '..', 'data', 'horkram-opret-helper.html'));
const BASE   = arg('--base', '');   // tom = relativ URL

if (!fs.existsSync(INPUT)) {
    console.error('✗ Input-fil ikke fundet:', INPUT);
    console.error('  Kør først: node --experimental-sqlite scripts/horkram-favorit-status.js --include-generated --json data/horkram-status.json');
    process.exit(1);
}

const data = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
const uncoupled = data.uncoupled || [];

// Tærskel for "match findes — tjek inden du opretter ny"
const MATCH_THRESHOLD = 0.4;

// Sortér: dyreste pr. kg først (typisk vigtigst)
function pricePerKg(v) {
    return v.snapshot?.pricePerKg ?? -1;
}
uncoupled.sort((a, b) => pricePerKg(b) - pricePerKg(a));

// Split i to bunker
const withMatch    = uncoupled.filter(v => (v.fuzzy_matches?.[0]?.sim ?? 0) >= MATCH_THRESHOLD);
const withoutMatch = uncoupled.filter(v => (v.fuzzy_matches?.[0]?.sim ?? 0) <  MATCH_THRESHOLD);

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatPrice(n) {
    if (n == null) return '—';
    return n.toFixed(2).replace('.', ',') + ' kr';
}

function buildLink(varenr) {
    return `${BASE}/kitchen/stock.html?tab=create&barcode=${encodeURIComponent(varenr)}`;
}

function renderCard(v, idx) {
    const snap = v.snapshot;
    const matches = v.fuzzy_matches || [];
    const orgFlag = v.is_organic ? '<span class="org">🌿Ø</span>' : '';
    const aftaleFlag = snap?.isAgreementItem ? '<span class="aftale">💰 AFTALEPRIS</span>' : '';
    const lists = (v.lists || []).join(', ');

    let unitsHtml = '—';
    if (snap?.salesUnits?.length) {
        unitsHtml = snap.salesUnits.map(u => {
            const qty = u.quantity ? ` ${u.quantity}` : '';
            const price = u.salesPrice ?? u.listPrice;
            const def = u.isDefault ? ' <em>(default)</em>' : '';
            return `<code>${esc(u.code)}${qty}</code> ${formatPrice(price)}${def}`;
        }).join(' · ');
    }

    // Sales-unit data til auto-kobl (default unit)
    const defaultSu = snap?.salesUnits?.find(u => u.isDefault) || snap?.salesUnits?.[0] || null;
    const kobldata = {
        varenr: v.varenummer,
        name: v.name,
        isAgreement: snap?.isAgreementItem ? '1' : '',
        suCode: defaultSu?.code || '',
        suQty: defaultSu?.quantity ? String(defaultSu.quantity) : ''
    };
    const kobldataAttr = ` data-kobl='${esc(JSON.stringify(kobldata))}'`;

    let matchHtml = '';
    if (matches.length) {
        matchHtml = '<div class="matches"><strong>⚠ Mulige Grocy-matches:</strong><ul>' +
            matches.slice(0, 3).map(m => {
                const tag = m.sim >= 0.7 ? '🟢' : m.sim >= 0.5 ? '🟡' : '⚪';
                return `<li>
                  <span class="match-label">${tag} ${Math.round(m.sim * 100)}% — ${esc(m.name)} (id ${m.id})</span>
                  <button class="btn btn-mini btn-kobl" data-varenr="${esc(v.varenummer)}" data-pid="${m.id}"${kobldataAttr}>
                    🔗 Kobl til denne
                  </button>
                </li>`;
            }).join('') + '</ul></div>';
    }

    return `
<div class="vare" data-varenr="${esc(v.varenummer)}">
  <div class="vare-head">
    <div class="vare-num">#${idx + 1}</div>
    <div class="vare-name">
      <h3>${esc(v.name)} ${orgFlag}</h3>
      <div class="meta">
        Varenr <code>${esc(v.varenummer)}</code>
        ${v.brand ? ' · ' + esc(v.brand) : ''}
        ${aftaleFlag ? ' · ' + aftaleFlag : ''}
      </div>
      <div class="meta-small">På lister: ${esc(lists)}</div>
    </div>
    <div class="vare-actions">
      <label class="done-toggle">
        <input type="checkbox" class="done-cb" data-varenr="${esc(v.varenummer)}">
        <span>Færdig</span>
      </label>
    </div>
  </div>
  <div class="vare-details">
    <div class="detail-row"><span class="label">Salgsenheder:</span> ${unitsHtml}</div>
    ${snap?.pricePerKg != null ? `<div class="detail-row"><span class="label">Pris/kg:</span> ${formatPrice(snap.pricePerKg)}</div>` : ''}
    ${matchHtml}
  </div>
  <div class="vare-links">
    <button class="btn btn-search" data-varenr="${esc(v.varenummer)}"${kobldataAttr}>
      🔍 Søg eksisterende Grocy-vare
    </button>
    <a class="btn btn-primary" href="${buildLink(v.varenummer)}" target="_blank" rel="noopener">
      ➕ Opret som ny i Grocy →
    </a>
    ${snap?.url ? `<a class="btn btn-link" href="${esc(snap.url)}" target="_blank" rel="noopener">Se på hoka.dk ↗</a>` : ''}
  </div>
  <div class="search-panel" data-varenr="${esc(v.varenummer)}" hidden>
    <input type="text" class="search-input" placeholder="Skriv navn eller produkt-id..." autocomplete="off">
    <div class="search-results"></div>
  </div>
</div>`;
}

const html = `<!DOCTYPE html>
<html lang="da">
<head>
<meta charset="UTF-8">
<title>Hørkram opret-helper — ${uncoupled.length} varer</title>
<style>
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; background: #f5f4f2; color: #2c2418; }
  .header { background: #8e631f; color: white; padding: 16px 24px; position: sticky; top: 0; z-index: 10; box-shadow: 0 2px 6px rgba(0,0,0,0.2); }
  .header h1 { margin: 0 0 8px 0; font-size: 22px; }
  .header .progress { background: rgba(255,255,255,0.2); border-radius: 6px; height: 24px; position: relative; overflow: hidden; }
  .header .progress-bar { background: #5cb85c; height: 100%; transition: width 0.3s; }
  .header .progress-text { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-weight: 600; }
  .toolbar { display: flex; gap: 12px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
  .toolbar label { color: white; cursor: pointer; user-select: none; }
  .toolbar button { background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.4); color: white; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
  .toolbar button:hover { background: rgba(255,255,255,0.25); }

  main { padding: 24px; max-width: 1100px; margin: 0 auto; }
  .section-head { margin: 24px 0 12px 0; padding-bottom: 8px; border-bottom: 2px solid #d7d1ca; }
  .section-head h2 { margin: 0; font-size: 18px; }
  .section-head p { margin: 4px 0 0 0; color: #6b6354; font-size: 13px; }

  .vare { background: white; border: 1px solid #d7d1ca; border-radius: 8px; padding: 16px; margin-bottom: 12px; transition: opacity 0.2s; }
  .vare.is-done { opacity: 0.4; background: #f0efeb; }
  .vare.is-done .vare-name h3 { text-decoration: line-through; }

  .vare-head { display: flex; gap: 16px; align-items: flex-start; }
  .vare-num { color: #b0a895; font-weight: 600; font-size: 16px; min-width: 36px; }
  .vare-name { flex: 1; }
  .vare-name h3 { margin: 0; font-size: 16px; }
  .meta { color: #6b6354; font-size: 12px; margin-top: 4px; }
  .meta-small { color: #908775; font-size: 11px; margin-top: 2px; }
  code { background: #f0efeb; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  .org { color: #4a7a3a; font-weight: 600; }
  .aftale { color: #c4831f; font-weight: 600; }

  .done-toggle { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; padding: 6px 10px; border: 1px solid #d7d1ca; border-radius: 4px; background: #f8f7f4; }
  .done-toggle input { width: 16px; height: 16px; }

  .vare-details { margin: 12px 0; padding: 12px; background: #faf9f6; border-radius: 6px; font-size: 13px; }
  .detail-row { margin: 4px 0; }
  .label { color: #6b6354; font-weight: 600; display: inline-block; min-width: 110px; }
  .matches { margin-top: 8px; padding: 10px; background: #fff8e1; border-left: 3px solid #c4831f; border-radius: 4px; }
  .matches ul { margin: 6px 0 0 0; padding-left: 20px; }

  .vare-links { display: flex; gap: 10px; flex-wrap: wrap; }
  .btn { display: inline-block; padding: 8px 14px; border-radius: 4px; text-decoration: none; font-weight: 600; font-size: 13px; border: none; cursor: pointer; font-family: inherit; }
  .btn-primary { background: #8e631f; color: white; }
  .btn-primary:hover { background: #6d4a17; }
  .btn-link { color: #8e631f; }
  .btn-link:hover { text-decoration: underline; }
  .btn-mini { padding: 4px 10px; font-size: 12px; }
  .btn-kobl { background: #4a7a3a; color: white; margin-left: 8px; }
  .btn-kobl:hover { background: #3a5f2d; }
  .btn-kobl:disabled { background: #999; cursor: not-allowed; }
  .btn-search { background: #f0efeb; color: #8e631f; border: 1px solid #d7d1ca; }
  .btn-search:hover { background: #e7e3dc; }
  .btn-search.is-open { background: #8e631f; color: white; }

  .search-panel { margin-top: 12px; padding: 12px; background: #faf9f6; border: 1px solid #d7d1ca; border-radius: 6px; }
  .search-input { width: 100%; padding: 8px 12px; border: 1px solid #d7d1ca; border-radius: 4px; font-size: 14px; font-family: inherit; }
  .search-input:focus { outline: none; border-color: #8e631f; box-shadow: 0 0 0 2px rgba(142,99,31,0.2); }
  .search-results { margin-top: 8px; max-height: 280px; overflow-y: auto; }
  .search-result { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border-bottom: 1px solid #ecebe6; }
  .search-result:last-child { border-bottom: none; }
  .search-result .name { flex: 1; }
  .search-result .pid { color: #908775; font-size: 12px; }
  .search-result mark { background: #fff2c4; padding: 0; }
  .search-empty { padding: 12px; color: #908775; font-style: italic; text-align: center; }

  .matches ul li { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 4px 0; flex-wrap: wrap; }
  .match-label { flex: 1; }

  .hide-done .vare.is-done { display: none; }

  .toast { position: fixed; bottom: 24px; right: 24px; background: #2c2418; color: white; padding: 12px 18px; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); font-size: 14px; z-index: 100; opacity: 0; transition: opacity 0.2s; pointer-events: none; max-width: 360px; }
  .toast.show { opacity: 1; }
  .toast.error { background: #b94a48; }
</style>
</head>
<body>
<div class="header">
  <h1>Hørkram opret-helper · ${uncoupled.length} varer</h1>
  <div class="progress">
    <div class="progress-bar" id="progressBar" style="width: 0%"></div>
    <div class="progress-text" id="progressText">0 / ${uncoupled.length} oprettet</div>
  </div>
  <div class="toolbar">
    <label><input type="checkbox" id="hideDone"> Skjul oprettede</label>
    <button id="resetBtn">Nulstil progress</button>
    <span style="color: rgba(255,255,255,0.7); font-size: 12px; margin-left: auto;">
      Genereret ${new Date(data.generated_at).toLocaleString('da-DK')}
    </span>
  </div>
</div>

<main id="main">
  ${withMatch.length ? `
  <div class="section-head">
    <h2>⚠ ${withMatch.length} varer med mulige eksisterende matches</h2>
    <p>Tjek om varen allerede findes i Grocy inden du opretter ny. Brug evt. Settings → Indkøb → Hørkram → "Ny kobling" til at koble.</p>
  </div>
  ${withMatch.map(renderCard).join('\n')}
  ` : ''}

  ${withoutMatch.length ? `
  <div class="section-head">
    <h2>➕ ${withoutMatch.length} varer der skal oprettes som nye Grocy-produkter</h2>
    <p>Ingen sandsynlige matches. Klik "Opret i Grocy →" — Hørkram-lookup pre-fylder navn/pris/enhed automatisk.</p>
  </div>
  ${withoutMatch.map((v, i) => renderCard(v, i + withMatch.length)).join('\n')}
  ` : ''}
</main>

<script>
(function() {
    var STORAGE_KEY = 'horkram-opret-helper-done';
    var TOTAL = ${uncoupled.length};
    var shoppingLocationId = null;

    function loadDone() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
        catch (e) { return []; }
    }
    function saveDone(arr) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
    }

    var done = loadDone();
    var doneSet = new Set(done);
    var allProducts = [];  // Hentes ved load — bruges af søge-panelet
    var productsLoading = null;

    function refreshUI() {
        var cards = document.querySelectorAll('.vare');
        cards.forEach(function(card) {
            var varenr = card.dataset.varenr;
            var isDone = doneSet.has(varenr);
            card.classList.toggle('is-done', isDone);
            var cb = card.querySelector('.done-cb');
            if (cb) cb.checked = isDone;
        });
        var doneCount = doneSet.size;
        document.getElementById('progressBar').style.width = (100 * doneCount / TOTAL) + '%';
        document.getElementById('progressText').textContent = doneCount + ' / ' + TOTAL + ' færdige';
    }

    function toast(msg, isError) {
        var el = document.getElementById('toast');
        el.textContent = msg;
        el.className = 'toast show' + (isError ? ' error' : '');
        clearTimeout(el._t);
        el._t = setTimeout(function() { el.className = 'toast'; }, 4000);
    }

    // Pre-fetch Hørkrams shopping_location_id ved load (samme logik som auto-kobl-scriptet)
    fetch('/api/purchasing/suppliers/grocy-locations')
        .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
        .then(function(data) {
            var hk = (data.locations || []).filter(function(l) {
                return l.linked_supplier_name && /hørkram|hoka/i.test(l.linked_supplier_name);
            });
            shoppingLocationId = hk.length ? hk[0].grocy_location_id : null;
            if (!shoppingLocationId) {
                toast('Advarsel: Ingen Grocy-lokation er koblet til Hørkram. Kobl-knapperne virker ikke.', true);
            }
        })
        .catch(function(err) {
            toast('Kan ikke nå Bon v2 API: ' + err.message + ' — kobl-knapper er deaktiveret.', true);
        });

    async function handleKobl(btn) {
        if (shoppingLocationId == null) {
            toast('shopping_location_id ikke loaded — prøv at reloade siden.', true);
            return;
        }
        var varenr = btn.dataset.varenr;
        var pid    = parseInt(btn.dataset.pid, 10);
        var kobl   = JSON.parse(btn.dataset.kobl || '{}');

        btn.disabled = true;
        btn.textContent = '⏳ Kobler...';

        try {
            // 1. POST barcode
            var bcRes = await fetch('/api/grocy/product-barcodes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    product_id: pid,
                    barcode: varenr,
                    shopping_location_id: shoppingLocationId,
                    note: kobl.name || ''
                })
            });
            if (!bcRes.ok) {
                var errBody = await bcRes.text();
                if (bcRes.status === 409) {
                    toast('⏭ Allerede koblet — markerer som færdig', false);
                    doneSet.add(varenr); saveDone([...doneSet]); refreshUI();
                    return;
                }
                throw new Error('HTTP ' + bcRes.status + ': ' + errBody.slice(0, 150));
            }
            var bc = await bcRes.json();
            var bcId = bc?.created_object_id || bc?.id || bc?.bc?.id;

            // 2. PUT userfields (best-effort)
            if (bcId) {
                var uf = {};
                if (kobl.isAgreement) uf.is_agreement_item = '1';
                if (kobl.suCode)      uf.supplier_unit_code = kobl.suCode;
                if (kobl.suQty)       uf.supplier_unit_qty  = kobl.suQty;
                if (Object.keys(uf).length) {
                    try {
                        await fetch('/api/grocy/userfields/product_barcodes/' + bcId, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(uf)
                        });
                    } catch (e) { /* ignorér userfield-fejl */ }
                }
            }

            toast('✓ Koblet til product_id=' + pid, false);
            doneSet.add(varenr); saveDone([...doneSet]); refreshUI();
        } catch (err) {
            btn.disabled = false;
            btn.textContent = '🔗 Kobl til denne';
            toast('Fejl: ' + err.message, true);
        }
    }

    document.querySelectorAll('.btn-kobl').forEach(function(btn) {
        btn.addEventListener('click', function() { handleKobl(btn); });
    });

    // ── Søg eksisterende Grocy-produkt ─────────────────────
    function ensureProductsLoaded() {
        if (allProducts.length) return Promise.resolve(allProducts);
        if (productsLoading) return productsLoading;
        productsLoading = fetch('/api/grocy/products')
            .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
            .then(function(prods) {
                allProducts = (Array.isArray(prods) ? prods : []).map(function(p) {
                    return { id: p.id, name: p.name || '', lc: (p.name || '').toLowerCase() };
                });
                return allProducts;
            });
        return productsLoading;
    }

    function escHtml(s) {
        return String(s).replace(/[&<>"']/g, function(c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function highlight(name, query) {
        if (!query) return escHtml(name);
        var i = name.toLowerCase().indexOf(query.toLowerCase());
        if (i < 0) return escHtml(name);
        return escHtml(name.slice(0, i)) + '<mark>' + escHtml(name.slice(i, i + query.length)) + '</mark>' + escHtml(name.slice(i + query.length));
    }

    function renderResults(panel, query) {
        var resultsEl = panel.querySelector('.search-results');
        resultsEl.innerHTML = '';
        if (!query.trim()) return;

        var q = query.toLowerCase().trim();
        var qInt = parseInt(q, 10);
        var hits = allProducts.filter(function(p) {
            if (!isNaN(qInt) && p.id === qInt) return true;
            return p.lc.indexOf(q) >= 0;
        }).slice(0, 12);

        if (!hits.length) {
            var empty = document.createElement('div');
            empty.className = 'search-empty';
            empty.textContent = 'Ingen Grocy-produkter matcher "' + query + '"';
            resultsEl.appendChild(empty);
            return;
        }

        var card = panel.closest('.vare');
        var varenr = panel.dataset.varenr;
        var koblDataStr = card.querySelector('.btn-search').dataset.kobl;

        hits.forEach(function(p) {
            var row = document.createElement('div');
            row.className = 'search-result';

            var nameEl = document.createElement('span');
            nameEl.className = 'name';
            nameEl.innerHTML = highlight(p.name, query);

            var pidEl = document.createElement('span');
            pidEl.className = 'pid';
            pidEl.textContent = 'id ' + p.id;

            var btn = document.createElement('button');
            btn.className = 'btn btn-mini btn-kobl';
            btn.dataset.varenr = varenr;
            btn.dataset.pid = String(p.id);
            btn.dataset.kobl = koblDataStr;
            btn.textContent = '🔗 Kobl';
            btn.addEventListener('click', function() { handleKobl(btn); });

            row.appendChild(nameEl);
            row.appendChild(pidEl);
            row.appendChild(btn);
            resultsEl.appendChild(row);
        });
    }

    document.querySelectorAll('.btn-search').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var card = btn.closest('.vare');
            var panel = card.querySelector('.search-panel');
            var isOpen = !panel.hidden;
            if (isOpen) {
                panel.hidden = true;
                btn.classList.remove('is-open');
                return;
            }
            panel.hidden = false;
            btn.classList.add('is-open');
            var input = panel.querySelector('.search-input');
            input.focus();
            ensureProductsLoaded()
                .then(function() {
                    if (input.value) renderResults(panel, input.value);
                })
                .catch(function(err) {
                    panel.querySelector('.search-results').innerHTML =
                        '<div class="search-empty">Kunne ikke hente produkter: ' + escHtml(err.message) + '</div>';
                });
        });
    });

    document.querySelectorAll('.search-input').forEach(function(input) {
        var t = null;
        input.addEventListener('input', function() {
            clearTimeout(t);
            t = setTimeout(function() {
                var panel = input.closest('.search-panel');
                renderResults(panel, input.value);
            }, 150);
        });
    });

    document.querySelectorAll('.done-cb').forEach(function(cb) {
        cb.addEventListener('change', function() {
            var varenr = cb.dataset.varenr;
            if (cb.checked) doneSet.add(varenr); else doneSet.delete(varenr);
            saveDone([...doneSet]);
            refreshUI();
        });
    });

    document.getElementById('hideDone').addEventListener('change', function(e) {
        document.body.classList.toggle('hide-done', e.target.checked);
    });

    document.getElementById('resetBtn').addEventListener('click', function() {
        if (!confirm('Nulstil al progress?')) return;
        doneSet.clear();
        saveDone([]);
        refreshUI();
    });

    refreshUI();
})();
</script>
<div id="toast" class="toast"></div>
</body>
</html>
`;

// Skriv output
const outDir = path.dirname(OUTPUT);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(OUTPUT, html);

console.log('✓ Genereret:', OUTPUT);
console.log(`  ${uncoupled.length} varer total`);
console.log(`  ${withMatch.length} med mulige Grocy-matches (tjek først)`);
console.log(`  ${withoutMatch.length} klar til at oprettes som nye produkter`);
console.log('');
console.log('Åbn filen i browseren — eller hvis serveren servere data/ kan du tilgå');
console.log(`  ${BASE || '<din-server>'}/data/horkram-opret-helper.html`);
