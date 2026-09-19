// scripts/test-optaelling-felter.js
// ============================================================
// Optællingen tæller i flere enheder på én gang (#665, §14.6).
//
// shared/inventory_check.js og shared/mangde_felter.js er browser-kode. De
// indlæses i Node med en lille DOM, og de RIGTIGE funktioner kaldes —
// _icMountCount, _icAdjustQty, _icConfirmCount, _icExecuteCommit. Det der
// måles er det brugeren ser (felterne, summen) og det der sendes til
// serveren (posterne), ikke en intern tilstand.
//
//   node scripts/test-optaelling-felter.js
// ============================================================
'use strict';
// Advarslens klokkeslæt vises i dansk tid, uanset hvor testen køres.
process.env.TZ = 'Europe/Copenhagen';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${m}`); c ? pass++ : fail++; };
const eq = (a, b, m) => ok(a === b, `${m} — fik ${JSON.stringify(a)}`);
const tæt = (a, b, m) => ok(Math.abs(a - b) < 1e-9, `${m} — fik ${a}`);

/* ── En DOM der er lige rig nok til at felterne kan bygges ──────── */
function lavElement(tag) {
    const el = {
        tagName: String(tag).toUpperCase(),
        children: [], className: '', textContent: '', innerHTML: '', value: '', type: '',
        style: {}, dataset: {}, disabled: false, _lyt: {},
        classList: {
            _s: new Set(),
            add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
            toggle(c, on) { on === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (on ? this._s.add(c) : this._s.delete(c)); },
            contains(c) { return this._s.has(c); },
        },
        appendChild(c) { this.children.push(c); c.parentEl = this; return c; },
        insertBefore(c) { this.children.unshift(c); return c; },
        _attr: {},
        setAttribute(k, v) { this._attr[k] = String(v); this[k] = v; },
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attr, k) ? this._attr[k] : null; },
        addEventListener(t, fn) { (this._lyt[t] = this._lyt[t] || []).push(fn); },
        removeEventListener() {},
        closest(sel) {
            // className OG classList: komponenterne sætter klasser begge veje,
            // og en stub der kun kender den ene lyver om hvad browseren finder.
            var n = this, k = sel.replace(/^\./, '');
            while (n) {
                if (n.classList && n.classList.contains(k)) return n;
                if (String(n.className || '').split(' ').indexOf(k) >= 0) return n;
                n = n.parentEl;
            }
            return null;
        },
        // Nok til ".klasse", ".forfader .barn" og '.k[attr="v"]' — mere har
        // koden ikke brug for, og en halv CSS-motor i en test er sin egen fejlkilde.
        _søg(sel) {
            var dele = String(sel).trim().split(/\s+/).map(function (d) {
                var m = d.match(/^\.?([\w-]+)?(?:\[([\w-]+)="?([^\]"]*)"?\])?$/);
                return m ? { klasse: m[1] || null, attr: m[2] || null, værdi: m[3] } : { klasse: d };
            });
            var sidste = dele[dele.length - 1];
            var fundne = (this.find && sidste.klasse ? this.find(sidste.klasse) : []);
            if (sidste.attr) {
                fundne = fundne.filter(function (n) { return n.getAttribute(sidste.attr) === sidste.værdi; });
            }
            if (dele.length === 1) return fundne;
            var først = dele[0];
            return fundne.filter(function (n) {
                var a = n.parentEl;
                while (a) { if (a.classList && a.classList.contains(først.klasse)) return true; a = a.parentEl; }
                return false;
            });
        },
        querySelector(sel) { return this._søg(sel)[0] || null; },
        querySelectorAll(sel) { return this._søg(sel); },
        dispatchEvent(ev) { (this._lyt[ev && ev.type] || []).forEach(fn => fn.call(this, ev)); return true; },
        focus() {}, select() {}, remove() {},
        /** Skriv i feltet og fyr den lytter browseren ville fyre. */
        skriv(v) { this.value = String(v); (this._lyt.input || []).forEach(fn => fn.call(this, {})); },
        /** Alle efterkommere med en given klasse — til at læse det brugeren ser. */
        find(klasse) {
            var ud = [];
            (function gå(n) {
                for (var i = 0; i < n.children.length; i++) {
                    var c = n.children[i];
                    if (c.classList && c.classList.contains(klasse)) ud.push(c);
                    if (String(c.className || '').split(' ').indexOf(klasse) >= 0) {
                        if (ud.indexOf(c) < 0) ud.push(c);
                    }
                    gå(c);
                }
            })(this);
            return ud;
        },
    };
    // innerHTML = '' skal rydde børn, ellers hober de sig op ved hver render
    // og testen måler noget andet end skærmen viser.
    Object.defineProperty(el, 'innerHTML', {
        get() { return el._html || ''; },
        set(v) { el._html = v; if (v === '') el.children = []; },
    });
    return el;
}


function LilleEvent(type) { this.type = type; }

// Globalt miljø, som browseren giver det.
globalThis.window = globalThis;
globalThis.Event = LilleEvent;
globalThis.document = { createElement: lavElement, getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: lavElement('div') };
globalThis.esc = (s) => String(s);
require(path.join(__dirname, '..', 'shared', 'mangde_felter.js'));
const IC = require(path.join(__dirname, '..', 'shared', 'inventory_check.js'));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'shared', 'inventory_check.js'), 'utf8');
const _ic = IC._ic;

// Brød Rug: kilo på lager (4), kasse ved køb (13 = 7,68 kg), stk ved forbrug (7 = 0,0081 kg).
const BROED = { id: 7, name: 'Brød Rug', qu_id_stock: 4, qu_id_purchase: 13, qu_id_consume: 7 };
function nulstil() {
    _ic.physicalUnit = 'KØL-1';
    _ic.products = [BROED];
    _ic.productsById = { 7: BROED };
    _ic.grocyStock = { 7: { amount: 47, unit: 'Kilo' } };
    _ic.quantityUnits = { 4: 'Kilo', 13: 'Kasse', 7: 'stk' };
    _ic.conversions = [
        { product_id: 7, from_qu_id: 13, to_qu_id: 4, factor: 7.68 },
        { product_id: 7, from_qu_id: 7, to_qu_id: 4, factor: 0.0081 },
    ];
    _ic.counts = {}; _ic.decisions = {}; _ic.skipped = []; _ic.skippedByUnit = {};
    _ic.countUnitPref = {}; _ic.startedAt = null;
}

// Et kort med de dele _icCreateCard lægger ind; felterne bygges af den rigtige kode.
function lavKort() {
    const kort = lavElement('div');
    kort.className = 'ic-card'; kort.dataset.productId = '7';
    const host = lavElement('div'); host.className = 'ic-mf-host';
    const ned = lavElement('button'); ned.className = 'ic-qty-btn'; ned.setAttribute('data-action', 'minus');
    const op = lavElement('button'); op.className = 'ic-qty-btn'; op.setAttribute('data-action', 'plus');
    const sum = lavElement('span'); sum.className = 'ic-mf-sum';
    const delta = lavElement('span'); delta.className = 'ic-mf-delta';
    [ned, op, host, sum, delta].forEach(e => kort.appendChild(e));
    IC._icSetContainer({ querySelector: () => kort, querySelectorAll: () => [kort] });
    return kort;
}
const felterI = (kort) => kort.find('mf-field').filter((f, i, a) => a.indexOf(f) === i);
const enhedAf = (felt) => felt.find('mf-unit')[0].textContent;
const inputAf = (felt) => felt.find('mf-input')[0];

console.log('\n── Felterne: alle enheder på én gang ──');
nulstil();
let kort = lavKort();
IC._icMountCount(kort, BROED, 47);
let felter = felterI(kort);
eq(felter.map(enhedAf).join(','), 'Kilo,Kasse,stk', 'tre felter — lager-enheden først når intet er husket');
eq(inputAf(felter[0]).value, '47', 'lager-feltet er forudfyldt med det forventede');
eq(inputAf(felter[1]).value, '', 'kasse-feltet er tomt');
ok(!!kort._icMf, 'kortet bærer sine felter (til Gem)');
ok(felter[0].classList.contains('ic-mf-aktiv'), 'første felt er markeret fra start');

console.log('\n── Gem: 2 kasser og 25 løse stk ──');
inputAf(felter[0]).skriv('');
inputAf(felter[1]).skriv('2');
inputAf(felter[2]).skriv('25');
ok(/= 15,563 Kilo/.test(kort.find('ic-mf-sum')[0].textContent), 'summen står i lager-enhed: ' + kort.find('ic-mf-sum')[0].textContent);
ok(/i forhold til forventet 47/.test(kort.find('ic-mf-delta')[0].textContent), 'forskellen til det forventede kan ses før Gem: ' + kort.find('ic-mf-delta')[0].textContent);
IC._icConfirmCount(7);
const c = _ic.counts[7];
eq(c.units['KØL-1'], 15.56, 'tællingen er summen i lager-enhed');
const poster = (c && c.entries && c.entries['KØL-1']) || [];
eq(poster.length, 2, 'to poster — det tomme felt er ikke med');
eq(poster.map(p => p.qu_id).join(','), '13,7', 'posterne bærer enheden');
tæt(poster[0] ? poster[0].factor_used : NaN, 7.68, 'og faktoren på tastetidspunktet (§14.4)');
eq(_ic.countUnitPref['7|KØL-1'], 13, 'enheden der bar mest (kasserne) huskes for netop denne placering');

console.log('\n── Den huskede enhed står først næste gang ──');
kort = lavKort();
IC._icMountCount(kort, BROED, 47);
felter = felterI(kort);
eq(enhedAf(felter[0]), 'Kasse', 'kasser står først i KØL-1');
eq(inputAf(felter[0]).value, '6,12', 'dansk komma i feltet');
tæt(MangdeFelter._num(inputAf(felter[0]).value), 6.12, 'og er forudfyldt omregnet (47 / 7,68)');
_ic.physicalUnit = 'TØR-1';
kort = lavKort();
IC._icMountCount(kort, BROED, 47);
eq(enhedAf(felterI(kort)[0]), 'Kilo', 'en anden placering husker for sig selv');
_ic.physicalUnit = 'KØL-1';

console.log('\n── ± rammer det markerede felt ──');
nulstil();
kort = lavKort();
IC._icMountCount(kort, BROED, 47);
felter = felterI(kort);
const række = kort.find('mf-row')[0];
række.dispatchEvent({ type: 'focusin', target: inputAf(felter[2]) });
ok(felter[2].classList.contains('ic-mf-aktiv') && !felter[0].classList.contains('ic-mf-aktiv'), 'fokus flytter markeringen');
IC._icAdjustQty(7, 1);
eq(inputAf(felter[2]).value, '1', 'plus lagde 1 til stk-feltet');
eq(inputAf(felter[0]).value, '47', 'og rørte ikke lager-feltet');
ok(/stk/.test(række.children[0].title || ''), 'pilens tooltip nævner enheden: ' + række.children[0].title);

console.log('\n── Dansk komma ──');
inputAf(felter[1]).skriv('2,5');
IC._icConfirmCount(7);
tæt(((_ic.counts[7]?.entries?.['KØL-1'] || []).find(p => p.qu_id === 13) || {}).qty, 2.5, '"2,5" kasser er 2,5 — ikke tomt, ikke 2');
række.dispatchEvent({ type: 'focusin', target: inputAf(felter[1]) });
IC._icAdjustQty(7, 1);
eq(inputAf(felter[1]).value, '3,5', '± læser kommaet: 2,5 + 1 = 3,5 (parseFloat ville give 3)');
console.log('\n── Enter gemmer, ↩ nulstiller ──');
_ic.counts = {};   // så det er Enter der gemmer, ikke kommaet ovenfor
række.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} });
const efterEnter = _ic.counts[7]?.entries?.['KØL-1'] || [];
ok(efterEnter.some(p => p.qu_id === 13 && p.qty === 3.5), 'Enter gemmer det der står i felterne (3,5 kasser): ' + JSON.stringify(efterEnter));
nulstil();
kort = lavKort();
IC._icMountCount(kort, BROED, 47);
inputAf(felterI(kort)[0]).skriv('3');
IC._icCancelExpand(7);
eq(inputAf(felterI(kort)[0]).value, '47', '↩ lægger det forventede tilbage');
ok(!_ic.counts[7], '… og gemmer intet');

console.log('\n── ✔ "tallet passer" gemmer også en post ──');
nulstil();
IC._icSaveCount(7, 47);
const p2 = _ic.counts[7]?.entries?.['KØL-1'] || [];
ok(p2.length === 1 && p2[0].qu_id === 4 && p2[0].factor_used === 1 && p2[0].qty === 47,
   'én post i lager-enheden med faktor 1 (§15.11): ' + JSON.stringify(p2));
IC._icSaveCount(7, 0);
eq((_ic.counts[7]?.entries?.['KØL-1'] || [null]).length, 0, 'et nul er ingen post');

console.log('\n── Serveren får posterne ──');
nulstil();
const kald = [];
globalThis.postGrocyInventory = async function () { kald.push([].slice.call(arguments)); return { ok: true }; };
globalThis.putGrocyProductUserfields = async () => ({ ok: true });
IC._icSaveCount(7, 15.36, [{ qu_id: 13, qty: 2, factor_used: 7.68 }]);
_ic.physicalUnit = 'KØL-2';
IC._icSaveCount(7, 0.2025, [{ qu_id: 7, qty: 25, factor_used: 0.0081 }]);
eq(IC._icCommitEntries(7).length, 2, 'posterne samles på tværs af placeringer');
(async () => {
    const plan = IC._icPlanCommit({ '7': 47 });
    await IC._icExecuteCommit(plan);
    const inv = kald[0] || [];
    ok(Array.isArray(inv[3]) && inv[3].length === 2, 'inventory-kaldet bærer posterne som 4. argument');
    eq(inv[2], undefined, 'og ingen udløbsdato (Bug 2)');

    // En session fra før felterne: ingen poster → det gamle kald, ikke en halv liste.
    nulstil(); kald.length = 0;
    _ic.counts[7] = { units: { 'KØL-1': 10, 'KØL-2': 5 }, total: 15, lastUnit: 'KØL-2', grocyAtCount: 47,
                      entries: { 'KØL-2': [{ qu_id: 4, qty: 5, factor_used: 1 }] } };
    eq(IC._icCommitEntries(7), null, 'mangler én placering sine poster, sendes ingen');
    await IC._icExecuteCommit(IC._icPlanCommit({ '7': 47 }));
    eq((kald[0] || []).length, 2, 'og kaldet er det gamle (antal, uden poster)');


    console.log('\n── #673: optællingen som objekt ──');
    const mem = {};
    globalThis.localStorage = {
        getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); },
        removeItem: k => { delete mem[k]; }, key: i => Object.keys(mem)[i], get length() { return Object.keys(mem).length; },
    };
    const MAYO = { id: 8, name: 'Mayo', qu_id_stock: 4 };
    const OST  = { id: 9, name: 'Ost', qu_id_stock: 4 };
    const srv = { opret: [], åbne: [], linjer: [], luk: [], kassér: [], patch: [], fejlInv: false, logFejl: null, nede: false };
    function nulstilServer() {
        Object.assign(srv, { opret: [], åbne: [], linjer: [], luk: [], kassér: [], patch: [], fejlInv: false, logFejl: null, nede: false });
        kald.length = 0;
    }
    globalThis.createStockCount = async (loc, unitId, unitName) => {
        if (srv.nede) throw new Error('Failed to fetch');
        srv.opret.push({ loc, unitId, unitName });
        return { count: { id: 42 }, others: [{ id: 41, started_at: '2026-09-19 08:12:00', user_name: 'Køkken', physical_unit_name: 'KØL-2' }] };
    };
    globalThis.fetchOpenStockCounts = async (loc, ex) => { srv.åbne.push({ loc, ex }); return { others: [] }; };
    globalThis.patchStockCount = async (id, unitId, name) => { srv.patch.push({ id, unitId, name }); return {}; };
    globalThis.postStockCountLines = async (id, products) => { srv.linjer.push({ id, products }); return { logged: products.length, errors: [] }; };
    globalThis.finishStockCount = async (id) => { srv.luk.push(id); return {}; };
    globalThis.discardStockCount = async (id) => { srv.kassér.push(id); return {}; };
    globalThis.postGrocyInventory = async function () {
        kald.push([].slice.call(arguments));
        if (srv.fejlInv) throw new Error('Grocy nede');
        return srv.logFejl ? { ok: true, log_error: srv.logFejl } : { ok: true };
    };

    function scenarie() {
        nulstil(); nulstilServer();
        _ic.locationId = 2; _ic.locationName = 'Køleskab';
        _ic.physicalUnits = { 2: [{ id: 1, name: 'KØL-1' }, { id: 2, name: 'KØL-2' }] };
        _ic.products = [BROED, MAYO, OST];
        _ic.productsById = { 7: BROED, 8: MAYO, 9: OST };
        _ic.grocyStock = { 7: { amount: 47 }, 8: { amount: 3 }, 9: { amount: 5 } };
        _ic.countId = null; _ic.sortSeq = 0;
        // Brød: 2 kasser i KØL-1, 25 stk i KØL-2 → rettes.
        _ic.physicalUnit = 'KØL-1';
        IC._icSaveCount(7, 15.36, [{ qu_id: 13, qty: 2, factor_used: 7.68 }]);
        // Mayo: tallet passer.
        IC._icSaveCount(8, 3);
        // Ost: lageret har flyttet sig, brugeren beholdt lagerets tal.
        IC._icSaveCount(9, 4);
        _ic.counts[9].conflictResolved = 'keep';
        _ic.physicalUnit = 'KØL-2';
        IC._icSaveCount(7, 0.2025, [{ qu_id: 7, qty: 25, factor_used: 0.0081 }]);
        // Brød rettes i KØL-1 igen — rækkefølgen må ikke flytte sig.
        _ic.physicalUnit = 'KØL-1';
        IC._icSaveCount(7, 15.36, [{ qu_id: 13, qty: 2, factor_used: 7.68 }]);
    }
    const frisk = { '7': 47, '8': 3, '9': 6 };

    scenarie();
    eq(JSON.stringify(_ic.counts[7].sortIndex), '{"KØL-1":1,"KØL-2":4}', 'rækkefølgen er første gang i hver enhed — en rettelse flytter den ikke');
    let res = await IC._icExecuteCommit(IC._icPlanCommit(frisk));
    eq(srv.opret.length, 1, 'optællingen oprettes ved Gem når Start ikke nåede serveren');
    const brødKald = kald.find(k => k[0] === 7) || [];
    const cnt = brødKald[4] || {};
    eq(cnt.id, 42, 'lagerkaldet bærer optællingens id');
    eq(cnt.expected_qty, 47, 'forventet = Grocys tal da varen blev talt');
    eq((cnt.lines || []).length, 2, 'én linje pr. fysisk enhed');
    const l1 = (cnt.lines || []).find(l => l.physical_unit_name === 'KØL-1') || {};
    const l2 = (cnt.lines || []).find(l => l.physical_unit_name === 'KØL-2') || {};
    ok(l1.physical_unit_id === 1 && (l1.entries || [])[0]?.qu_id === 13, 'kasserne står i KØL-1 med enhedens id');
    ok(l2.physical_unit_id === 2 && (l2.entries || [])[0]?.qu_id === 7, 'de løse stk står i KØL-2 — posterne beholder deres enhed');
    eq(l2.sort_index, 4, 'rækkefølgen følger med');
    eq((brødKald[3] || []).length, 2, 'Grocys sum får stadig alle poster');
    const sendt = (srv.linjer[0] || {}).products || [];
    eq(sendt.map(p => p.product_id + ':' + p.outcome).join(','), '8:unchanged,9:kept_stock',
       'tallet passer og lagerets tal beholdt logges også — i ét kald');
    eq(kald.filter(k => k[0] === 8).length, 0, 'men Grocy røres ikke for dem');
    eq(srv.luk.join(','), '42', 'optællingen lukkes når alt lykkedes');
    ok(!res.logFejl && !res.logMangler, 'intet at sige om historikken');

    scenarie(); srv.fejlInv = true;
    res = await IC._icExecuteCommit(IC._icPlanCommit(frisk));
    const fejlet = ((srv.linjer[0] || {}).products || []).find(p => p.product_id === 7);
    eq(fejlet && fejlet.outcome, 'failed', 'en lagerskrivning der fejlede, logges som talt — ikke som rettet');
    eq(srv.luk.length, 0, 'og optællingen står åben, så et nyt Gem skriver videre i den');

    scenarie(); srv.logFejl = 'optællingen er lukket (saved)';
    res = await IC._icExecuteCommit(IC._icPlanCommit(frisk));
    eq(res.logFejl, 1, 'en log-fejl fra lagerkaldet tælles');
    ok(/1 vare blev ikke gemt i optællingens historik/.test(IC._icCommitMessage(IC._icPlanCommit(frisk), res)),
       'og siges i kvitteringen: ' + IC._icCommitMessage(IC._icPlanCommit(frisk), res));

    scenarie(); srv.nede = true;
    res = await IC._icExecuteCommit(IC._icPlanCommit(frisk));
    eq(kald.filter(k => k[0] === 7).length, 1, 'uden server rettes lageret stadig');
    eq((kald.find(k => k[0] === 7) || []).length, 4, '… med det gamle kald (ingen optælling at hænge det på)');
    ok(/kunne ikke gemmes i historikken/.test(IC._icCommitMessage(IC._icPlanCommit(frisk), res)),
       'og kvitteringen siger at historikken mangler');

    console.log('\n── #673: Start, genoptagelse, advarsel ──');
    scenarie();
    await IC._icBeginServerCount();
    eq(_ic.countId, 42, 'Start opretter optællingen');
    _ic.countId = null;
    IC._icLoadCounts();
    eq(_ic.countId, 42, 'id overlever i sessionen — en genoptaget session fortsætter samme optælling');
    srv.opret.length = 0;
    await IC._icBeginServerCount();
    eq(srv.opret.length, 0, 'genoptaget: ingen ny optælling');
    eq((srv.åbne[0] || {}).ex, 42, '… men andre åbne hentes, uden én selv');
    IC._icClearCounts();
    eq(_ic.countId, null, 'kasseret session glemmer id');
    const tekst = IC._icConcurrentText([{ started_at: '2026-09-19 08:12:00', user_name: 'Køkken', physical_unit_name: 'KØL-2' }], 'Køleskab');
    ok(/Køleskab \(KØL-2\), startet 10:12/.test(tekst), 'advarslen siger hvor og hvornår (dansk tid): ' + tekst);
    ok(!/Køkken/.test(tekst), 'men ikke rollekontoens navn');
    eq(IC._icConcurrentText([], 'Køleskab'), '', 'ingen andre → ingen advarsel');
    const mange = IC._icConcurrentText([1, 2, 3, 4].map(i => ({ started_at: '2026-09-19 08:1' + i + ':00', physical_unit_name: i < 4 ? 'KØL-1' : 'KØL-2' })), 'Køleskab');
    ok(/^Der er 4 andre optællinger i gang i Køleskab \(KØL-1, KØL-2\), senest startet 10:14\./.test(mange),
       'mange samles på én linje, enhederne uden gentagelser: ' + mange);
    const skift = SRC.slice(SRC.indexOf('function _icSwitchToUnit'), SRC.indexOf('function _icSwitchToUnit') + 800);
    ok(/_icSendCurrentUnit\(\)/.test(skift), 'chip-skift sender hvor tælleren står');
    const nulstilKnap = SRC.slice(SRC.indexOf("'#icResumeReset'"), SRC.indexOf("'#icResumeReset'") + 300);
    ok(/_icDiscardServerCount\(\)/.test(nulstilKnap), '"Start forfra" kasserer optællingen på serveren');
    console.log('\n── Wiring ──');
    const opret = SRC.slice(SRC.indexOf('function _icCreateCard'), SRC.indexOf('function _icMarkSeen'));
    ok(/_icMountCount\(card, fullProduct, defaultVal\)/.test(opret), 'kortet monterer felterne');
    ok(!/data-action="frac"/.test(SRC) && !/_icIsPackUnit/.test(SRC), 'brøkknapperne er væk');

    console.log(`\n${pass} PASS · ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
