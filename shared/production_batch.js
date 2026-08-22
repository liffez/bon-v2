/* ════════════════════════════════════════════════════════════
 * shared/production_batch.js — Produktionsbatch-editor (MVP, trin 3)
 * Spec: docs/CLAUDE_PRODUKTION_MVP.md §4 + §12.
 *
 * Mountes af recipe_viewer.js når "Producér" klikkes på en RR Produktion-
 * opskrift. Opskriften er en immutabel skabelon; her laver man en KOPI med
 * dagens faktiske tal. Intet trækkes før eksplicit klik på produktions-knappen.
 *
 * To tilfælde (afgjort af recipe.product_id):
 *   - med product_id  → consume råvarer + læg færdigvaren på lager
 *   - uden product_id → consume-only (kun råvaretræk, intet output)
 *
 * Linje-operationer (§4): justér (stepper/input), fjern (→0 = udeladt),
 * byt (original → byttet + erstatningsvare), tilføj vare (ny Grocy-vare).
 *
 * Plain script (var/function) — matcher recipe_viewer.js. Eksponeres som
 * window.ProductionBatch.
 * ════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    var TOL = 1e-9;
    var _st = null;   // aktiv editor-state

    function isProductionRecipe(recipe) {
        if (!recipe) return false;
        var g = recipe.group || (recipe.userfields && recipe.userfields.grupper) || '';
        return /rr\s*produktion/i.test(String(g));
    }

    function _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function _num(v) {
        var s = String(v == null ? '' : v).trim().replace(',', '.');
        var n = parseFloat(s);
        return isFinite(n) ? n : 0;
    }
    function _fmt(n) {
        var r = Math.round((n + Number.EPSILON) * 1000) / 1000;
        return String(r).replace('.', ',');
    }
    function _nonce() {
        try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
        return 'pb-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    }

    // Afvigelses-årsag pr. linje (bruges som deviation_reason + diff-tæller).
    function _deviation(line) {
        if (line.kind === 'added') return 'tilfoejet';
        if (line.kind === 'sub') return 'byttet';
        if (line.swappedOut) return 'byttet';
        if (line.actual <= TOL) return 'udeladt';
        if (Math.abs(line.actual - line.planned) > TOL) return 'justeret';
        return null;
    }

    /**
     * Forventet udbytte i output-produktets lager-enhed.
     * null = kan ikke udledes → feltet står tomt og brugeren taster selv.
     * Reglen er delt med serveren (shared/recipe_yield.js), så batchen og
     * kostpris-beregningen ikke kan blive uenige om hvad opskriften giver.
     */
    function _plannedStock(recipe, product, units, conversions, portions) {
        if (!window.RecipeYield || !product) return null;
        return window.RecipeYield.plannedYieldStock(recipe, product, units, conversions || [], portions);
    }

    function _diffCount() {
        return _st.lines.filter(function (l) { return _deviation(l) !== null; }).length;
    }
    function _devTag(dev) {
        if (dev === 'udeladt')   return '<span class="pb-tag pb-tag-out">manglede</span>';
        if (dev === 'justeret')  return '<span class="pb-tag pb-tag-adj">justeret</span>';
        if (dev === 'byttet')    return '<span class="pb-tag pb-tag-swap">byttet</span>';
        if (dev === 'tilfoejet') return '<span class="pb-tag pb-tag-add">tilføjet</span>';
        return '';
    }

    /**
     * Åbn editoren i en container.
     * @param {object} opts { recipe, ingredients, productsMap, quUnitsMap, container, onClose }
     */
    function open(opts) {
        var recipe = opts.recipe;
        var base = parseFloat(recipe.base_servings) || 1;
        var productsMap = opts.productsMap || {};
        var quUnitsMap = opts.quUnitsMap || {};

        var lines = (opts.ingredients || []).map(function (pos) {
            var pid = pos.product_id;
            var product = productsMap[pid] || {};
            var stockQuId = product.qu_id_stock || pos.qu_id;
            var unit = quUnitsMap[stockQuId] || '';
            var perPortion = (parseFloat(pos.amount) || 0) / base;
            return {
                kind: 'master',
                pid: pid,
                name: product.name || ('#' + pid),
                stockQuId: stockQuId,
                unit: unit,
                perPortion: perPortion,
                planned: perPortion * base,
                actual: perPortion * base,
                swappedOut: false,
            };
        });

        // Søgbar produktliste til "tilføj vare" / "byt" (fra allerede-loadede produkter)
        var allProducts = Object.keys(productsMap).map(function (id) {
            var p = productsMap[id];
            var quId = p.qu_id_stock;
            return { id: parseInt(id), name: p.name || ('#' + id), stockQuId: quId, unit: quUnitsMap[quId] || '' };
        }).filter(function (p) { return p.name; });

        var hasOutput = !!(recipe.product_id && String(recipe.product_id) !== '0');
        var outProduct = hasOutput ? (productsMap[recipe.product_id] || null) : null;
        // Grocy lægger udbyttet på lageret i produktets LAGER-enhed, uanset hvad
        // opskriftens fritekst-`recipeunit` siger. Feltet mærkes derfor med
        // lager-enheden, og det er den enhed tallet sendes i (#360).
        var outQuId = outProduct ? outProduct.qu_id_stock : null;
        var outUnit = (outQuId != null && quUnitsMap[outQuId]) ? quUnitsMap[outQuId] : '';
        var unitsArr = Object.keys(quUnitsMap).map(function (id) {
            return { id: parseInt(id), name: quUnitsMap[id] };
        });
        var startYield = hasOutput ? _plannedStock(recipe, outProduct, unitsArr, opts.conversions, base) : 0;

        _st = {
            recipe: recipe,
            hasOutput: hasOutput,
            outProduct: outProduct,
            outQuId: outQuId,
            outUnit: outUnit,
            unitsArr: unitsArr,
            conversions: opts.conversions || [],
            container: opts.container,
            onClose: opts.onClose || function () {},
            base: base,
            portions: base,
            lines: lines,
            allProducts: allProducts,
            picker: null,                 // { mode:'add'|'swap', forIndex, query }
            // Udbytte i LAGER-enhed. null = kan ikke udledes (opskriften mangler
            // `recipeunitnumber`, eller der findes ingen omregning) → feltet står
            // tomt, og brugeren taster selv. Vi gætter ikke.
            yield: startYield,
            plannedYield: startYield,
            addMissing: false,
            nonce: _nonce(),              // R7: genereres ved åbning, genbruges ved retry
            busy: false,
            done: false,
        };
        _render();
    }

    function _recompute() {
        _st.lines.forEach(function (l) {
            if (l.kind !== 'master') return;     // tilføjede/byttede skaleres ikke af portioner
            l.planned = l.perPortion * _st.portions;
            if (!l.swappedOut) l.actual = l.planned;
        });
        if (_st.hasOutput) {
            var y = _plannedStock(_st.recipe, _st.outProduct, _st.unitsArr, _st.conversions, _st.portions);
            _st.plannedYield = y;
            _st.yield = y;
        }
    }

    function _render() {
        var c = _st.container;
        if (!c) return;
        if (_st.done) { _renderResult(); return; }

        var diff = _diffCount();
        var hasUdeladt = _st.lines.some(function (l) { return _deviation(l) === 'udeladt'; });
        var rUnit = _esc(_st.recipe.recipeUnit || 'enh');

        var rows = _st.lines.map(function (l, i) {
            var dev = _deviation(l);
            var isExtra = (l.kind === 'added' || l.kind === 'sub');
            var masterCell = isExtra ? '<span class="pb-l-extra">ny</span>' : (_fmt(l.planned) + ' ' + _esc(l.unit));
            // Handlinger: master → ∅ (fjern/udeladt) + ⇄ (byt); ekstra → × (fjern række)
            var lineActions = isExtra
                ? '<button type="button" class="pb-rm" data-i="' + i + '" title="Fjern linje">✕</button>'
                : '<button type="button" class="pb-miss" data-i="' + i + '" title="Manglede (sæt 0)">∅</button>' +
                  '<button type="button" class="pb-swap" data-i="' + i + '" title="Byt ud med anden vare">⇄</button>';
            return '' +
                '<tr class="pb-line' + (dev ? ' pb-line-dev' : '') + (l.swappedOut ? ' pb-line-swapped' : '') + '" data-i="' + i + '">' +
                    '<td class="pb-l-name">' + _esc(l.name) + ' ' + _devTag(dev) + '</td>' +
                    '<td class="pb-l-master">' + masterCell + '</td>' +
                    '<td class="pb-l-actual">' +
                        '<button type="button" class="pb-step" data-act="dec" data-i="' + i + '"' + (l.swappedOut ? ' disabled' : '') + '>&minus;</button>' +
                        '<input type="text" class="pb-actual-input" data-i="' + i + '" value="' + _fmt(l.actual) + '" inputmode="decimal"' + (l.swappedOut ? ' disabled' : '') + '>' +
                        '<button type="button" class="pb-step" data-act="inc" data-i="' + i + '"' + (l.swappedOut ? ' disabled' : '') + '>+</button>' +
                        '<span class="pb-l-unit">' + _esc(l.unit) + '</span>' +
                        lineActions +
                    '</td>' +
                '</tr>';
        }).join('');

        var pickerHtml = _st.picker ? _pickerHtml() : '';

        var yUnit = _esc(_st.outUnit || rUnit);
        var yVal  = (_st.yield == null) ? '' : _fmt(_st.yield);
        // Kan udbyttet ikke udledes, siges det — et default på "antal portioner"
        // ville lande som kilo på lageret uden at nogen så det (#360).
        var yHint = (_st.yield == null && _st.hasOutput)
            ? '<div class="pb-yield-hint">Opskriften erklærer ikke sit udbytte i ' + yUnit +
              ' — tast hvor meget der faktisk kom ud.</div>'
            : '';
        var yieldRow = _st.hasOutput
            ? '<div class="pb-yield"><label>Faktisk udbytte</label>' +
              '<input type="text" id="pbYield" value="' + yVal + '" inputmode="decimal"><span class="pb-l-unit">' + yUnit + '</span></div>' + yHint
            : '<div class="pb-consume-only">Consume-only — råvarer trækkes, intet lægges på lager.</div>';

        var missingChk = hasUdeladt
            ? '<label class="pb-missing-chk"><input type="checkbox" id="pbAddMissing"' + (_st.addMissing ? ' checked' : '') + '> Læg manglende råvarer på indkøbsliste</label>'
            : '';

        var btnLabel = diff === 0 ? 'Producér som planlagt' : ('Producér batch (' + diff + ' ' + (diff === 1 ? 'ændring' : 'ændringer') + ')');

        c.innerHTML = '' +
            '<div class="pb-panel">' +
                '<div class="pb-head">' +
                    '<div class="pb-title">Producér: ' + _esc(_st.recipe.name) + '</div>' +
                    '<span class="pb-badge ' + (_st.hasOutput ? 'pb-badge-stock' : 'pb-badge-consume') + '">' +
                        (_st.hasOutput ? '→ lægges på lager' : 'consume-only') + '</span>' +
                    '<button type="button" class="pb-close" id="pbClose">✕</button>' +
                '</div>' +
                '<div class="pb-portions">' +
                    '<span>Portioner:</span>' +
                    '<button type="button" class="pb-step" id="pbPortMinus">&minus;</button>' +
                    '<input type="text" id="pbPortions" value="' + _fmt(_st.portions) + '" inputmode="decimal">' +
                    '<button type="button" class="pb-step" id="pbPortPlus">+</button>' +
                    '<span class="pb-port-note">(skalerer master-tal; nulstiller faktisk)</span>' +
                '</div>' +
                '<table class="pb-table"><thead><tr><th>Råvare</th><th>Master</th><th>Faktisk</th></tr></thead>' +
                    '<tbody>' + rows + '</tbody></table>' +
                '<div class="pb-add-row"><button type="button" class="pb-add-btn" id="pbAddLine">+ Tilføj vare</button></div>' +
                pickerHtml +
                yieldRow +
                missingChk +
                '<div class="pb-actions">' +
                    '<button type="button" class="pb-produce-btn' + (diff > 0 ? ' pb-produce-dev' : '') + '" id="pbProduce"' + (_st.busy ? ' disabled' : '') + '>' +
                        (_st.busy ? 'Producerer…' : _esc(btnLabel)) + '</button>' +
                '</div>' +
                '<div class="pb-msg" id="pbMsg"></div>' +
            '</div>';

        _bind();
    }

    function _pickerHtml() {
        var title = _st.picker.mode === 'swap' ? 'Byt ud med…' : 'Tilføj vare';
        return '' +
            '<div class="pb-picker">' +
                '<div class="pb-picker-head">' +
                    '<span class="pb-picker-title">' + title + '</span>' +
                    '<input type="text" id="pbPickQuery" placeholder="Søg produkt…" value="' + _esc(_st.picker.query || '') + '" autocomplete="off">' +
                    '<button type="button" class="pb-pick-cancel" id="pbPickCancel">Annuller</button>' +
                '</div>' +
                '<ul class="pb-picker-list" id="pbPickList">' + _pickerListHtml() + '</ul>' +
            '</div>';
    }

    function _pickerListHtml() {
        var q = (_st.picker.query || '').trim().toLowerCase();
        var existing = {};
        _st.lines.forEach(function (l) { if (!l.swappedOut) existing[l.pid] = true; });
        var matches = _st.allProducts.filter(function (p) {
            if (existing[p.id]) return false;
            return !q || p.name.toLowerCase().indexOf(q) !== -1;
        }).slice(0, 12);
        if (!matches.length) return '<li class="pb-pick-empty">Ingen match</li>';
        return matches.map(function (p) {
            return '<li class="pb-pick-item" data-pid="' + p.id + '">' + _esc(p.name) +
                ' <span class="pb-l-unit">' + _esc(p.unit) + '</span></li>';
        }).join('');
    }

    function _bind() {
        var c = _st.container;
        var byId = function (id) { return c.querySelector('#' + id); };

        byId('pbClose').addEventListener('click', _close);
        byId('pbProduce').addEventListener('click', _submit);
        byId('pbAddLine').addEventListener('click', function () { _openPicker('add'); });

        byId('pbPortMinus').addEventListener('click', function () { _setPortions(_st.portions - 1); });
        byId('pbPortPlus').addEventListener('click', function () { _setPortions(_st.portions + 1); });
        byId('pbPortions').addEventListener('change', function (e) { _setPortions(_num(e.target.value)); });

        if (_st.hasOutput) {
            var y = byId('pbYield');
            if (y) y.addEventListener('change', function (e) { _st.yield = _num(e.target.value); });
        }
        var addM = byId('pbAddMissing');
        if (addM) addM.addEventListener('change', function (e) { _st.addMissing = e.target.checked; });

        c.querySelectorAll('.pb-actual-input').forEach(function (inp) {
            inp.addEventListener('change', function (e) {
                _st.lines[+e.target.getAttribute('data-i')].actual = Math.max(0, _num(e.target.value));
                _render();
            });
        });
        c.querySelectorAll('.pb-step[data-act]').forEach(function (b) {
            b.addEventListener('click', function (e) {
                var i = +e.currentTarget.getAttribute('data-i');
                var act = e.currentTarget.getAttribute('data-act');
                var l = _st.lines[i];
                var ref = l.planned > 0 ? l.planned : (l.actual > 0 ? l.actual : 1);
                var stepVal = Math.max(0.001, Math.round(ref * 0.1 * 1000) / 1000);
                l.actual = Math.max(0, Math.round((l.actual + (act === 'inc' ? stepVal : -stepVal)) * 1000) / 1000);
                _render();
            });
        });
        c.querySelectorAll('.pb-miss').forEach(function (b) {
            b.addEventListener('click', function (e) { _st.lines[+e.currentTarget.getAttribute('data-i')].actual = 0; _render(); });
        });
        c.querySelectorAll('.pb-swap').forEach(function (b) {
            b.addEventListener('click', function (e) { _openPicker('swap', +e.currentTarget.getAttribute('data-i')); });
        });
        c.querySelectorAll('.pb-rm').forEach(function (b) {
            b.addEventListener('click', function (e) { _removeLine(+e.currentTarget.getAttribute('data-i')); });
        });

        // Picker
        if (_st.picker) {
            var q = byId('pbPickQuery');
            if (q) {
                q.addEventListener('input', function (e) {
                    _st.picker.query = e.target.value;
                    var list = byId('pbPickList');
                    if (list) list.innerHTML = _pickerListHtml();
                });
                q.focus();
            }
            byId('pbPickCancel').addEventListener('click', _closePicker);
            c.querySelectorAll('.pb-pick-item').forEach(function (li) {
                li.addEventListener('click', function (e) { _pickProduct(+e.currentTarget.getAttribute('data-pid')); });
            });
            // delegering så nyrenderede list-items også virker
            var listEl = byId('pbPickList');
            if (listEl) listEl.addEventListener('click', function (e) {
                var item = e.target.closest('.pb-pick-item');
                if (item) _pickProduct(+item.getAttribute('data-pid'));
            });
        }
    }

    function _openPicker(mode, forIndex) {
        _st.picker = { mode: mode, forIndex: (forIndex == null ? -1 : forIndex), query: '' };
        _render();
    }
    function _closePicker() { _st.picker = null; _render(); }

    function _pickProduct(pid) {
        var p = _st.allProducts.find(function (x) { return x.id === pid; });
        if (!p) { _closePicker(); return; }
        var picker = _st.picker;

        if (picker.mode === 'swap' && picker.forIndex >= 0) {
            var orig = _st.lines[picker.forIndex];
            orig.swappedOut = true;
            orig.actual = 0;
            // erstatningslinje med original mængde som udgangspunkt
            _st.lines.push({
                kind: 'sub', pid: p.id, name: p.name, stockQuId: p.stockQuId, unit: p.unit,
                perPortion: 0, planned: 0, actual: orig.planned > 0 ? orig.planned : 1,
                substituteFor: orig.pid,
            });
        } else {
            _st.lines.push({
                kind: 'added', pid: p.id, name: p.name, stockQuId: p.stockQuId, unit: p.unit,
                perPortion: 0, planned: 0, actual: 1,
            });
        }
        _st.picker = null;
        _render();
    }

    function _removeLine(i) {
        var l = _st.lines[i];
        if (!l) return;
        // hvis det er en erstatning, fortryd byttet på originalen
        if (l.kind === 'sub' && l.substituteFor != null) {
            var orig = _st.lines.find(function (x) { return x.kind === 'master' && x.pid === l.substituteFor; });
            if (orig) { orig.swappedOut = false; orig.actual = orig.planned; }
        }
        _st.lines.splice(i, 1);
        _render();
    }

    function _setPortions(p) {
        p = Math.max(0, Math.round((p || 0) * 100) / 100);
        if (p <= 0) p = _st.base;
        _st.portions = p;
        _recompute();
        _render();
    }

    function _msg(html, type) {
        var el = _st.container.querySelector('#pbMsg');
        if (el) { el.className = 'pb-msg pb-msg-' + (type || 'info'); el.innerHTML = html; }
    }

    function _submit() {
        if (_st.busy) return;
        if (_st.portions <= 0) { _msg('Portioner skal være > 0', 'error'); return; }
        if (_st.hasOutput && !(_st.yield > 0)) {
            _msg('Faktisk udbytte skal være > 0 (i ' + (_st.outUnit || 'lager-enhed') + ')', 'error'); return;
        }

        var data = {
            recipe_id: _st.recipe.id,
            output_product_id: _st.hasOutput ? _st.recipe.product_id : null,
            portions: _st.portions,
            actual_yield: _st.hasOutput ? _st.yield : 0,
            planned_yield: _st.hasOutput ? _st.plannedYield : 0,
            // Enheden sendes MED, så serveren kan omregne i stedet for at gætte.
            yield_qu_id: _st.hasOutput ? _st.outQuId : null,
            output_unit: _st.outUnit || _st.recipe.recipeUnit || '',
            batch_nonce: _st.nonce,
            add_missing_to_shopping_list: !!_st.addMissing,
            lines: _st.lines.map(function (l) {
                return {
                    productId: l.pid,
                    productName: l.name,
                    plannedQty: l.planned,        // stock-enhed
                    actualQty: l.actual,          // stock-enhed
                    fromQuId: l.stockQuId,        // = toQuId → faktor 1 (ingen konvertering)
                    toQuId: l.stockQuId,
                    stockUnitName: l.unit,
                    deviationReason: _deviation(l),
                    substituteForProductId: l.substituteFor || null,
                };
            }),
        };

        _st.busy = true;
        _render();
        postProductionBatch(data).then(function (res) {
            _st.busy = false; _st.result = res; _st.done = true; _render();
        }).catch(function (err) {
            _st.busy = false; _render();
            var detail = '';
            if (err && err.body && err.body.details) {
                detail = ': ' + err.body.details.map(function (d) { return d.message || d.code; }).join('; ');
            }
            _msg('Kunne ikke producere' + _esc(detail || (err && err.message ? ': ' + err.message : '')), 'error');
        });
    }

    function _renderResult() {
        var c = _st.container;
        var res = _st.result || {};
        var g = res.grocy || {};
        var partial = g.state === 'partial';
        var failed = (g.failedLines || []);

        var costLine = _st.hasOutput && res.batch
            ? '<div class="pb-r-line">Kostpris: <strong>' + _fmt(res.batch.actual_cost) + ' kr</strong> ex moms' +
              (g.produceTx ? ' · lagt på lager ✓' : '') + '</div>'
            : '<div class="pb-r-line">Råvarekost: <strong>' + _fmt(res.batch ? res.batch.actual_cost : 0) + ' kr</strong> ex moms (consume-only)</div>';

        var failHtml = failed.length
            ? '<div class="pb-r-fail">⚠ ' + failed.length + ' linje(r) fejlede i Grocy: ' +
              _esc(failed.map(function (f) { return '#' + f.productId; }).join(', ')) + '</div>'
            : '';

        var shop = (res.shopping_added && res.shopping_added.length)
            ? '<div class="pb-r-line">🛒 ' + res.shopping_added.length + ' manglende råvare(r) lagt på indkøbsliste</div>'
            : '';

        c.innerHTML = '' +
            '<div class="pb-panel pb-result ' + (partial ? 'pb-result-partial' : 'pb-result-ok') + '">' +
                '<div class="pb-head">' +
                    '<div class="pb-title">' + (partial ? '⚠ Batch delvist produceret' : '✓ Batch produceret') + '</div>' +
                    '<button type="button" class="pb-close" id="pbClose">✕</button>' +
                '</div>' +
                '<div class="pb-r-body">' +
                    '<div class="pb-r-line">' + _esc(_st.recipe.name) + ' · ' + _fmt(_st.portions) + ' portion(er)</div>' +
                    costLine + failHtml + shop +
                '</div>' +
                '<div class="pb-actions"><button type="button" class="pb-produce-btn" id="pbDone">Luk</button></div>' +
            '</div>';

        c.querySelector('#pbClose').addEventListener('click', _close);
        c.querySelector('#pbDone').addEventListener('click', _close);
    }

    function _close() {
        var cb = _st && _st.onClose;
        if (_st && _st.container) _st.container.innerHTML = '';
        _st = null;
        if (cb) cb();
    }

    window.ProductionBatch = { open: open, isProductionRecipe: isProductionRecipe, close: _close };
})();
