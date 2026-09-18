/**
 * shared/mangde_felter.js
 * ════════════════════════════════════════════════════════════
 * Mængde tastet i flere enheder på én gang — "2 kasser og 25 stk".
 *
 * Entry: window.MangdeFelter.create({...}) / .unitsFor(...) / .factorTo(...)
 * Prefix: _mf
 *
 * Det er sådan mennesker tæller: det uåbnede i kasser, det åbnede i vægt,
 * resten i stykker. Ingen skal omregne i hovedet, og ingen skal taste
 * 3,06 kasser. Beskrevet i docs/CLAUDE_LAGEROPTAELLING.md §14.6.
 *
 * TO REGLER DER IKKE MÅ BRYDES:
 *
 *   1. Posteringen sker ALTID i lager-enhed. Felterne er udelukkende
 *      indtastningsform. Summen vises løbende, så det er tydeligt hvad
 *      der bliver posteret.
 *
 *   2. Hvert felt bærer sin egen `factor_used`, gemt på tastetidspunktet.
 *      Ændrer leverandøren kassestørrelsen senere, må en gammel postering
 *      ikke skifte betydning bagudrettet — og uden faktoren kan man ikke
 *      se forskel på en der tæller sjusket og en kassefaktor der er
 *      forkert (§14.9).
 *
 * Komponenten tilbydes KUN enheder hvor der findes en brugbar faktor til
 * lager-enheden. Et felt der fører til "kan ikke omregnes" er en fælde
 * (#358) — så hellere ét felt end tre, hvoraf to fejler bagefter.
 *
 * Bruges af varemodtagelsen (#658). Optællingen (#331 §14) skal bruge den
 * samme — derfor ligger den her og ikke inde i en skærm.
 * ════════════════════════════════════════════════════════════
 */

(function () {
    'use strict';

    /**
     * Faktor fra én enhed til en anden for et bestemt produkt.
     *
     * Spejler findConversionFactor i services/quConvert.js — samme
     * rækkefølge, samme sammenligning. Divergerer de to, siger skærmen god
     * for noget serveren bagefter nægter, og vi er tilbage ved #358.
     *
     * @returns {number|null} null når der ingen vej er
     */
    function factorTo(conversions, productId, fromQuId, toQuId) {
        var from = _mfInt(fromQuId);
        var to = _mfInt(toQuId);
        if (from === null || to === null) return null;
        if (from === to) return 1;

        var pid = _mfInt(productId);
        var c = Array.isArray(conversions) ? conversions : [];
        var i;

        for (i = 0; i < c.length; i++) {
            if (_mfInt(c[i].product_id) === pid &&
                _mfInt(c[i].from_qu_id) === from && _mfInt(c[i].to_qu_id) === to) {
                return _mfNum(c[i].factor) || 1;
            }
        }
        for (i = 0; i < c.length; i++) {
            if (_mfInt(c[i].product_id) === pid &&
                _mfInt(c[i].from_qu_id) === to && _mfInt(c[i].to_qu_id) === from) {
                return 1 / (_mfNum(c[i].factor) || 1);
            }
        }
        for (i = 0; i < c.length; i++) {
            if (!c[i].product_id &&
                _mfInt(c[i].from_qu_id) === from && _mfInt(c[i].to_qu_id) === to) {
                return _mfNum(c[i].factor) || 1;
            }
        }
        for (i = 0; i < c.length; i++) {
            if (!c[i].product_id &&
                _mfInt(c[i].from_qu_id) === to && _mfInt(c[i].to_qu_id) === from) {
                return 1 / (_mfNum(c[i].factor) || 1);
            }
        }
        return null;
    }

    /**
     * Hvilke enheder kan varen tastes i?
     *
     * Enhederne findes allerede på varen — indkøbs-, lager- og forbrugs-enhed
     * (§14.2). Der skal ikke vælges fra en liste og ikke oprettes stamdata.
     * Lager-enheden er altid med (faktor 1 pr. definition); de to andre kun
     * når de er forskellige OG har en faktor.
     *
     * Rækkefølge: den enhed man plejer at taste i står først (`focusQuId`),
     * ellers indkøbs-enheden — man modtager kasser, ikke kilo.
     *
     * @returns {Array<{qu_id:number, name:string, factor:number, role:string}>}
     */
    function unitsFor(opts) {
        var product = opts.product || {};
        var conversions = opts.conversions || [];
        var unitNames = opts.unitNames || {};
        var pid = _mfInt(product.id);
        var stock = _mfInt(product.qu_id_stock);
        if (stock === null) return [];

        var wanted = [
            { qu_id: _mfInt(product.qu_id_purchase), role: 'purchase' },
            { qu_id: stock, role: 'stock' },
            { qu_id: _mfInt(product.qu_id_consume), role: 'consume' }
        ];

        // Enheder kalderen SKAL have med — fx den enhed en bestilling står i.
        // Uden den ville en bestilt linje miste sit eget tal, fordi
        // indkøbslistens enhed ikke altid er varens indkøbs-enhed.
        var extra = Array.isArray(opts.extraQuIds) ? opts.extraQuIds : [];
        for (var e = 0; e < extra.length; e++) {
            wanted.push({ qu_id: _mfInt(extra[e]), role: 'extra' });
        }

        var out = [];
        var seen = {};
        for (var i = 0; i < wanted.length; i++) {
            var w = wanted[i];
            if (w.qu_id === null || seen[w.qu_id]) continue;
            var f = factorTo(conversions, pid, w.qu_id, stock);
            if (f === null || !(f > 0)) continue;   // ingen vej til lager-enheden — så tilbyd den ikke
            seen[w.qu_id] = true;
            out.push({
                qu_id: w.qu_id,
                name: unitNames[w.qu_id] || ('enhed ' + w.qu_id),
                factor: f,
                role: w.role
            });
        }

        // Den enhed man plejer at taste i står først og får fokus (§14.3).
        var focus = _mfInt(opts.focusQuId);
        if (focus !== null) {
            out.sort(function (a, b) {
                return (b.qu_id === focus ? 1 : 0) - (a.qu_id === focus ? 1 : 0);
            });
        }
        return out;
    }

    /** Summen af poster i lager-enhed. Det eneste tal der posteres. */
    function stockSum(entries) {
        var sum = 0;
        var list = Array.isArray(entries) ? entries : [];
        for (var i = 0; i < list.length; i++) {
            var q = _mfNum(list[i].qty);
            var f = _mfNum(list[i].factor_used);
            if (q === null || f === null) continue;
            sum += q * f;
        }
        // Flydende tal: 2 * 11 + 25 * 0.09 skal ikke blive 24.249999999999996.
        return Math.round(sum * 1e6) / 1e6;
    }

    /**
     * Byg felterne.
     *
     * @param {object} o
     *   product, conversions, unitNames   Grocy-stamdata
     *   focusQuId                         enheden man plejer at taste i
     *   entries                           startværdier [{qu_id, qty}]
     *   stockUnitName                     navnet på lager-enheden (til summen)
     *   onChange(entries, stockAmount)    kaldes ved hver ændring
     *   compact                           true → ingen sum-linje ved ét felt
     * @returns {{el:HTMLElement, entries:Function, stockAmount:Function, focus:Function}}
     */
    function create(o) {
        var units = unitsFor(o);
        var stockName = o.stockUnitName ||
            (o.unitNames || {})[_mfInt((o.product || {}).qu_id_stock)] || '';

        // Startværdier: kun felter vi faktisk tilbyder.
        var values = {};
        var start = Array.isArray(o.entries) ? o.entries : [];
        for (var s = 0; s < start.length; s++) {
            var sq = _mfInt(start[s].qu_id);
            if (sq !== null) values[sq] = _mfNum(start[s].qty);
        }

        var wrap = document.createElement('div');
        wrap.className = 'mf-wrap' + (units.length > 1 ? ' mf-multi' : '');

        var row = document.createElement('div');
        row.className = 'mf-row';
        wrap.appendChild(row);

        var sumEl = document.createElement('div');
        sumEl.className = 'mf-sum';

        var inputs = [];

        for (var i = 0; i < units.length; i++) {
            (function (u, first) {
                var field = document.createElement('div');
                field.className = 'mf-field';

                var input = document.createElement('input');
                input.className = 'mf-input';
                // type="text", IKKE "number": et number-felt giver et TOMT
                // value for "2,5" når browseren ikke er sat til komma — og så
                // ignoreres feltet tavst (tomt = ingen post). Danskere taster
                // komma. Optællingen har haft præcis dén guard siden #331.
                input.type = 'text';
                // Taltastatur på iPad/iPhone — og feltet tager imod
                // tastaturets "Scan tekst" uden videre.
                input.setAttribute('inputmode', 'decimal');
                input.setAttribute('autocomplete', 'off');
                input.setAttribute('aria-label', u.name);
                if (values[u.qu_id] !== null && values[u.qu_id] !== undefined) {
                    input.value = show(values[u.qu_id]);
                }
                input.addEventListener('input', function () {
                    values[u.qu_id] = _mfNum(this.value);
                    render();
                });
                field.appendChild(input);

                var label = document.createElement('span');
                label.className = 'mf-unit';
                label.textContent = u.name;
                field.appendChild(label);

                row.appendChild(field);
                inputs.push({ el: input, unit: u, first: first });
            })(units[i], i === 0);
        }

        if (units.length === 0) {
            var none = document.createElement('div');
            none.className = 'mf-none';
            none.textContent = 'Ingen enhed at taste i';
            row.appendChild(none);
        }

        // Sum-linjen vises kun når der ER noget at summere. Ved ét felt er
        // tallet og summen det samme, og en linje der gentager feltet er støj.
        if (units.length > 1 || !o.compact) wrap.appendChild(sumEl);

        function entries() {
            var out = [];
            for (var k = 0; k < units.length; k++) {
                var u = units[k];
                var q = values[u.qu_id];
                // Tomme felter ignoreres. Der er ingen forskel på 0 og blank.
                if (q === null || q === undefined || !(q > 0)) continue;
                out.push({ qu_id: u.qu_id, qty: q, factor_used: u.factor });
            }
            return out;
        }

        function render() {
            var e = entries();
            var total = stockSum(e);
            if (units.length > 1) {
                sumEl.textContent = e.length
                    ? '= ' + _mfFmt(total) + ' ' + stockName
                    : '';
                sumEl.classList.toggle('mf-sum-empty', !e.length);
            } else {
                sumEl.textContent = '';
            }
            if (typeof o.onChange === 'function') o.onChange(e, total);
        }

        render();

        return {
            el: wrap,
            entries: entries,
            stockAmount: function () { return stockSum(entries()); },
            units: function () { return units.slice(); },
            focus: function () {
                for (var k = 0; k < inputs.length; k++) {
                    if (inputs[k].first) { inputs[k].el.focus(); inputs[k].el.select(); return; }
                }
            }
        };
    }

    /* ── små hjælpere ───────────────────────────────────────── */

    function _mfInt(v) {
        if (v === null || v === undefined || v === '') return null;
        var n = parseInt(v, 10);
        return isNaN(n) ? null : n;
    }

    function _mfNum(v) {
        if (v === null || v === undefined || v === '') return null;
        // Dansk komma: feltet er type=number, men en indsat værdi kan bære det.
        var n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
        return isFinite(n) ? n : null;
    }

    /** Et tal som det skal stå i feltet: dansk komma, ingen afrunding. */
    function show(n) {
        if (n === null || n === undefined || n === '') return '';
        return String(n).replace('.', ',');
    }

    /** Læg delta til et felt og fortæl komponenten det — til ±-knapperne. */
    function step(input, delta) {
        if (!input) return;
        var v = _mfNum(input.value) || 0;
        var n = Math.max(0, Math.round((v + delta) * 1e6) / 1e6);
        input.value = show(n);
        var ev;
        try { ev = new Event('input', { bubbles: true }); } catch (e) { ev = { type: 'input' }; }
        input.dispatchEvent(ev);
    }

    function _mfFmt(n) {
        if (n === null || n === undefined) return '';
        var r = Math.round(n * 1000) / 1000;
        return String(r).replace('.', ',');
    }

    window.MangdeFelter = {
        create: create,
        unitsFor: unitsFor,
        factorTo: factorTo,
        stockSum: stockSum,
        show: show,
        step: step,
        // Til tests — de rene regler uden DOM.
        _num: _mfNum
    };
})();
