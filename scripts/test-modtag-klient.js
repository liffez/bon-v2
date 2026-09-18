// scripts/test-modtag-klient.js
// ============================================================
// Klient-siden af #658: de delte mængdefelter og varevælgeren.
//
// `shared/mangde_felter.js` og `shared/varemodtagelse.js` er browser-kode og
// kan ikke require'es. De køres i en vm-sandkasse med en lille DOM, hvorefter
// de rene funktioner kaldes direkte — samme mønster som
// scripts/test-varemodtagelse-client-units.js. Det er de SAMME funktioner
// browseren bruger, ikke en kopi.
//
// Serverens halvdel er dækket af tests/modtag_uden_bestilling.test.js.
//
//   node scripts/test-modtag-klient.js
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
let _ventPaa = Promise.resolve();
const ok = (c, m) => { console.log(`  ${c ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${m}`); c ? pass++ : fail++; };
const eq = (a, b, m) => ok(a === b, `${m} — fik ${JSON.stringify(a)}`);

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

const sandbox = {
    console, Event: LilleEvent,
    document: {
        createElement: lavElement,
        getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
        addEventListener: () => {}, body: lavElement('div'),
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: {
        _d: {},
        getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
        setItem(k, v) { this._d[k] = String(v); },
        removeItem(k) { delete this._d[k]; },
    },
    fetch: async () => ({ ok: true, json: async () => [] }),
    setTimeout, clearTimeout, alert: () => {}, confirm: () => true, prompt: () => null,
    navigator: { userAgent: 'test' },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const læs = (f) => fs.readFileSync(path.join(__dirname, '..', 'shared', f), 'utf8');
vm.runInContext(læs('mangde_felter.js'), sandbox, { filename: 'mangde_felter.js' });
vm.runInContext(læs('varemodtagelse.js'), sandbox, { filename: 'varemodtagelse.js' });

const MF = sandbox.window.MangdeFelter;

/* ── Fixture: driftens egne tal ─────────────────────────────────── */
// Brød Rug — Leifs eget eksempel: "2 kasser brød og 25 ekstra styk".
const BRØD = { id: 1, name: 'Brød Rug', qu_id_stock: 4, qu_id_purchase: 13, qu_id_consume: 7 };
// Spidskål: købes i Antal, lagerføres i Kilo, INGEN omregning. Et af de fem
// produkter i drift uden købs→lager-vej.
const SPIDSKÅL = { id: 2, name: 'Spidskål', qu_id_stock: 4, qu_id_purchase: 3, qu_id_consume: 3 };

const KONV = [
    { product_id: 1, from_qu_id: 13, to_qu_id: 4, factor: 11 },
    { product_id: 1, from_qu_id: 7, to_qu_id: 4, factor: 0.09 },
    { product_id: null, from_qu_id: 5, to_qu_id: 4, factor: 0.001 },   // global: gram → kilo
];
const NAVNE = { 3: 'Antal', 4: 'Kilo', 5: 'Gram', 7: 'stk', 13: 'Kasse' };

console.log('\n\x1b[1m1. Hvilke enheder kan der tastes i (§14.2)\x1b[0m');
{
    const u = MF.unitsFor({ product: BRØD, conversions: KONV, unitNames: NAVNE });
    eq(u.length, 3, 'Brød Rug har tre felter');
    eq(u.map(x => x.name).join('/'), 'Kasse/Kilo/stk', 'indkøbs-enheden står først — man modtager kasser');
    eq(u[0].factor, 11, 'faktoren følger med');
    eq(u[2].factor, 0.09, 'også for forbrugs-enheden');
}
{
    const u = MF.unitsFor({ product: SPIDSKÅL, conversions: KONV, unitNames: NAVNE });
    eq(u.length, 1, 'uden omregning tilbydes KUN lager-enheden');
    eq(u[0].name, 'Kilo', 'et felt der ikke kan omregnes ville være en fælde (#358)');
}
{
    const ens = { id: 3, qu_id_stock: 4, qu_id_purchase: 4, qu_id_consume: 4 };
    eq(MF.unitsFor({ product: ens, conversions: KONV, unitNames: NAVNE }).length, 1,
       'samme enhed tre gange giver ét felt, ikke tre');
}
{
    const u = MF.unitsFor({ product: BRØD, conversions: KONV, unitNames: NAVNE, focusQuId: 7 });
    eq(u[0].qu_id, 7, 'den enhed man plejer at taste i står først');
}
{
    // Bestillingens enhed er ikke altid varens indkøbs-enhed.
    const u = MF.unitsFor({ product: BRØD, conversions: KONV, unitNames: NAVNE, extraQuIds: [5] });
    ok(u.some(x => x.qu_id === 5), 'en enhed kalderen kræver kommer med (global omregning)');
    const u2 = MF.unitsFor({ product: BRØD, conversions: KONV, unitNames: NAVNE, extraQuIds: [99] });
    ok(!u2.some(x => x.qu_id === 99), '… men kun hvis den kan omregnes');
}

console.log('\n\x1b[1m2. Summen er det eneste der posteres (§14.4)\x1b[0m');
{
    eq(MF.stockSum([{ qu_id: 13, qty: 2, factor_used: 11 }, { qu_id: 7, qty: 25, factor_used: 0.09 }]),
       24.25, '2 kasser + 25 stk = 24,25 kg');
    eq(MF.stockSum([]), 0, 'ingen poster = 0');
    eq(MF.stockSum([{ qu_id: 13, qty: 2 }]), 0, 'en post uden faktor tæller ikke — vi gætter ikke');
}

console.log('\n\x1b[1m3. Felterne opfører sig som et menneske forventer\x1b[0m');
{
    let sidste = null;
    const f = MF.create({
        product: BRØD, conversions: KONV, unitNames: NAVNE,
        onChange: (e, sum) => { sidste = { e, sum }; },
    });
    const felter = f.el.children[0].children;       // .mf-row
    eq(felter.length, 3, 'tre felter renderes');

    felter[0].children[0].skriv('2');               // 2 Kasse
    eq(sidste.sum, 22, 'ét felt giver 22 kg');
    felter[2].children[0].skriv('25');              // 25 stk
    eq(sidste.sum, 24.25, 'begge felter summeres løbende');
    eq(f.entries().length, 2, 'to poster');

    felter[0].children[0].skriv('');                // tømt igen
    eq(sidste.sum, 2.25, 'tomme felter ignoreres');
    eq(f.entries().length, 1, 'og giver ingen post');

    felter[2].children[0].skriv('0');
    eq(f.entries().length, 0, 'der er ingen forskel på 0 og blank');
}
{
    const f = MF.create({ product: BRØD, conversions: KONV, unitNames: NAVNE });
    f.el.children[0].children[0].children[0].skriv('1.5');
    eq(f.stockAmount(), 16.5, 'decimaler regnes med');
    // type=number giver tom streng ved dansk komma i browseren, så kommaet
    // rammer kun en indsat eller programmatisk sat værdi. Parseren tåler det
    // alligevel — tallene i huset skrives med komma.
    eq(MF._num('1,5'), 1.5, 'dansk komma forstås af parseren');
    eq(MF._num(''), null, 'tomt er ikke nul');
    eq(MF._num('abc'), null, 'vrøvl er ikke nul');
}

console.log('\n\x1b[1m4. Varevælgeren finder varen (#658)\x1b[0m');
Object.assign(sandbox, {
    _vmProductById: { 1: BRØD, 2: SPIDSKÅL },
    _vmProductNames: { 1: 'Brød Rug', 2: 'Spidskål' },
    _vmProductStockQu: { 1: 4, 2: 4 },
    _vmQuNames: NAVNE,
    _vmConversions: KONV,
    _vmBarcodes: [
        { id: 10, product_id: 1, barcode: '60097769', shopping_location_id: 2,
          userfields: { hk_gtin: '5712940009900' } },
        { id: 11, product_id: 2, barcode: '34258514', shopping_location_id: 3, userfields: {} },
    ],
    _vmSupplierShopLoc: { 'Hørkram': [2], 'Inco': [3] },
    _vmPrices: {}, _vmPricesLoaded: false,
});
sandbox._vmState.items = [];

eq(sandbox._vmLookupCode('60097769')?.pid, 1, 'varenummeret findes');
eq(sandbox._vmLookupCode('5712940009900')?.pid, 1, 'GTIN findes også — begge prøves');
eq(sandbox._vmLookupCode('5712940009900')?.varenr, '60097769',
   'og det er VARENUMMERET der huskes, for det er prisens nøgle');
eq(sandbox._vmLookupCode('99999999'), null, 'ukendt kode gætter vi ikke på');
eq(sandbox._vmLookupCode('  '), null, 'tomt felt gør ingenting');

eq(sandbox._vmCandidateIds('Hørkram').join(','), '1', 'leverandøren udpeger sine egne varer');
eq(sandbox._vmCandidateIds('Inco').join(','), '2', 'og kun sine egne');
eq(sandbox._vmCandidateIds('Ukendt').length, 0, 'leverandør uden koblinger giver tom liste');

console.log('\n\x1b[1m5. En tilføjet vare er en RIGTIG Grocy-vare\x1b[0m');
{
    sandbox._vmState.items = [];
    ok(sandbox._vmAddProduct(1, '60097769'), 'varen lægges på');
    const it = sandbox._vmState.items[0];
    eq(it.grocy_product_id, 1, 'med produkt-id — det var dét de tre gamle linjer manglede');
    eq(it.qu_id, 13, 'og starter i indkøbs-enheden');
    eq(it.expected, 0, 'der er intet bestilt at holde den op mod');
    eq(it.varenrs.join(','), '60097769', 'det leverede varenummer huskes → entydig pris');
    ok(!sandbox._vmAddProduct(1, null), 'samme vare lægges ikke på to gange');
    eq(sandbox._vmState.items.length, 1, '… og listen vokser ikke');
}

console.log('\n\x1b[1m6. Linjens tal står i linjens EGEN enhed\x1b[0m');
{
    const it = sandbox._vmState.items[0];
    sandbox._vmApplyEntries(it, [{ qu_id: 13, qty: 2, factor_used: 11 }], 22);
    eq(it.received, 2, 'ét felt i linjens egen enhed → præcis det der blev tastet');
    eq(it.stockAmount, 22, 'og lagermængden ved siden af');

    sandbox._vmApplyEntries(it, [
        { qu_id: 13, qty: 2, factor_used: 11 }, { qu_id: 7, qty: 25, factor_used: 0.09 },
    ], 24.25);
    eq(it.received, 2.204545, '24,25 kg udtrykt i Kasse — så "modtaget mod bestilt" stadig kan sammenlignes');
    eq(it.entries.length, 2, 'posterne bæres med til serveren');
}

console.log('\n\x1b[1m7. Varen båret med fra lageroversigten\x1b[0m');
{
    sandbox.sessionStorage.setItem('vm_carry', JSON.stringify({
        items: [{ pid: 1, name: 'Brød Rug', qty: 3, qu_id: 13 }], ts: Date.now(),
    }));
    const c = sandbox._vmReadCarry();
    eq(c?.[0]?.pid, 1, 'overførslen læses');
    eq(sandbox.sessionStorage.getItem('vm_carry'), null,
       'og nøglen ryddes straks — et genindlæs må ikke lægge varen på igen');

    sandbox.sessionStorage.setItem('vm_carry', JSON.stringify({
        items: [{ pid: 1, qty: 3, qu_id: 13 }], ts: Date.now() - 40 * 60 * 1000,
    }));
    eq(sandbox._vmReadCarry(), null, 'en gammel overførsel dukker ikke op dagen efter');

    // En side der stod åben fra en tidligere version skriver den enkelte form.
    sandbox.sessionStorage.setItem('vm_carry', JSON.stringify({
        pid: 1, qty: 3, qu_id: 13, ts: Date.now(),
    }));
    eq(sandbox._vmReadCarry()?.length, 1, 'den gamle enkelt-form tabes ikke');

    sandbox._vmState.items = [];
    sandbox._vmCarry = [{ pid: 1, name: 'Brød Rug', qty: 3, qu_id: 13 }];
    sandbox._vmApplyCarry();
    const it = sandbox._vmState.items[0];
    eq(it?.grocy_product_id, 1, 'varen står på listen');
    eq(it?.received, 3, 'tallet er allerede tastet én gang — det skal ikke tastes igen');
    eq(it.entries?.[0]?.qu_id, 13, 'i den enhed lageroversigten brugte');
    ok(!!it?.fromCarry, 'og det kan ses hvor den kom fra');

    // Stod varen allerede på listen fra bestillingen, må den ikke komme to gange.
    sandbox._vmApplyCarry();
    eq(sandbox._vmState.items.length, 1, 'ingen dublet');

    sandbox._vmState.items = [];
    sandbox._vmCarry = [{ pid: 999, qty: 1, qu_id: 4 }];
    sandbox._vmApplyCarry();
    eq(sandbox._vmState.items.length, 0, 'en vare der ikke findes i Grocy lægges ikke på');

    // Retter man tre varer op, skal alle tre med — ikke kun den sidste.
    sandbox._vmState.items = [];
    sandbox._vmCarry = [
        { pid: 1, name: 'Brød Rug', qty: 3, qu_id: 13 },
        { pid: 2, name: 'Spidskål', qty: 5, qu_id: 4 },
        { pid: 999, qty: 1, qu_id: 4 },            // findes ikke — springes over
    ];
    sandbox._vmApplyCarry();
    eq(sandbox._vmState.items.length, 2, 'flere varer bæres med');
    eq(sandbox._vmState.items[1]?.received, 5, 'hver med sit eget tal');
}

console.log('\n\x1b[1m8. Varelisten er SYNLIG uden en bestilling\x1b[0m');
{
    // Drift 18. september: varekortene blev tegnet, men listen stod
    // display:none. Uden en bestilling er der ingen "Juster enkeltvis"-knap
    // til at åbne den, så INTET tilføjede klassen. Man kunne lægge en vare
    // på, se tælleren gå til 1, og ikke se hverken varen, mængdefelterne
    // eller prisen. Tilstanden var rigtig — skærmen var tom.
    sandbox._vmState.items = [];
    sandbox._vmState.supplierKey = 'Hørkram';
    sandbox._vmState.supplierName = 'Hørkram';
    sandbox._vmState.itemListOpen = false;
    sandbox._vmPicker = null;
    sandbox._vmAddProduct(1, null);

    const vært = lavElement('div');
    sandbox._vmDom.lagerContent = vært;
    sandbox._vmRenderLagerContent();

    const lister = vært.find('vm-item-list');
    ok(lister.length === 1, 'varelisten bygges');
    const åben = lister[0] && (lister[0].classList.contains('vm-open') ||
        String(lister[0].className).indexOf('vm-open') >= 0);
    ok(åben, 'og den er ÅBEN — ellers er kortene usynlige');
    ok(sandbox._vmState.itemListOpen === true,
       'uden bestilling åbnes listen af sig selv — der er intet at "godkende" først');

    const kort = vært.find('vm-item-card');
    eq(kort.length, 1, 'ét varekort');
}

console.log('\n\x1b[1m9. Leverandøren udledes af de medbragte varer\x1b[0m');
{
    // Drift 18. september: man klikkede "registrér som modtagelse" og landede
    // på en TOM skærm — varerne vises først når en leverandør er valgt. Men vi
    // kender dataene: varen har et varenummer, varenummeret et handelssted, og
    // handelsstedet en leverandør.
    eq(sandbox._vmSupplierForProducts([1]), 'Hørkram', 'ét varenummer peger på sin leverandør');
    eq(sandbox._vmSupplierForProducts([2]), 'Inco', 'og en anden vare på sin');
    eq(sandbox._vmSupplierForProducts([1, 2]), null,
       'peger varerne på hver sin leverandør, gætter vi ikke');
    eq(sandbox._vmSupplierForProducts([]), null, 'ingen varer, intet svar');
    eq(sandbox._vmSupplierForProducts([999]), null, 'ukendt vare giver intet svar');

    // Hele vejen: bar man en vare med, skal skærmen være udfyldt.
    sandbox._vmState.items = [];
    sandbox._vmState.supplierKey = '';
    sandbox._vmState.supplierName = '';
    sandbox._vmPicker = null;
    sandbox._vmCarry = [{ pid: 1, name: 'Brød Rug', qty: 3, qu_id: 13 }];
    sandbox._vmDom.lagerContent = lavElement('div');
    sandbox._vmDom.noSupplierMsg = lavElement('div');
    sandbox._vmDom.supplierSelect = lavElement('select');
    sandbox._vmOpenWithCarry();

    eq(sandbox._vmState.supplierKey, 'Hørkram', 'leverandøren vælges af sig selv');
    eq(sandbox._vmState.items.length, 1, 'og varen står på listen');
    eq(sandbox._vmState.items[0]?.received, 3, 'med tallet fra lageroversigten');
    eq(sandbox._vmDom.lagerContent.style.display, 'flex', 'lager-sektionen er åben');
}

{
    // Kan leverandøren ikke udledes, skal varerne vises ALLIGEVEL — de kom jo
    // uanset hvad. Ellers står man med en tom skærm og aner ikke hvorfor.
    sandbox._vmState.items = [];
    sandbox._vmState.supplierKey = '';
    sandbox._vmPicker = null;
    sandbox._vmCarry = [
        { pid: 1, name: 'Brød Rug', qty: 3, qu_id: 13 },
        { pid: 2, name: 'Spidskål', qty: 5, qu_id: 4 },
    ];
    sandbox._vmDom.lagerContent = lavElement('div');
    sandbox._vmDom.noSupplierMsg = lavElement('div');
    sandbox._vmDom.supplierSelect = lavElement('select');
    sandbox._vmOpenWithCarry();

    eq(sandbox._vmState.supplierKey, '', 'to leverandører → ingen vælges');
    eq(sandbox._vmState.items.length, 2, 'men begge varer vises');
    eq(sandbox._vmDom.lagerContent.style.display, 'flex', 'lager-sektionen er åben alligevel');
    ok(sandbox._vmDom.noSupplierMsg.textContent.indexOf('klar') >= 0,
       'og der står hvad der mangler, ikke "vælg leverandør for at se varer"');
}

console.log('\n\x1b[1m10. Kaldes _vmOpenWithCarry overhovedet?\x1b[0m');
{
    // En test der kalder funktionen direkte beviser at den VIRKER, ikke at
    // den bliver BRUGT. Uden dette tjek kunne kaldet fjernes fra init uden at
    // én eneste assert faldt — og så lander man på en tom skærm igen.
    const kilde = fs.readFileSync(path.join(__dirname, '..', 'shared', 'varemodtagelse.js'), 'utf8');
    const fra = kilde.indexOf('async function initVaremodtagelse');
    const til = kilde.indexOf('/* ── Skemaet');
    const krop = kilde.slice(fra, til);
    ok(fra >= 0 && til > fra, 'init-funktionen findes');
    ok(/^\s*_vmOpenWithCarry\(\);/m.test(krop),
       'init kalder _vmOpenWithCarry — ellers er den død kode');
}

console.log('\n\x1b[1m11. Lageroversigten: mængde i flere enheder\x1b[0m');
{
    // Egen sandkasse — stock_overview.js er en anden fil med andre globals.
    const soBox = {
        console, setTimeout, clearTimeout,
        document: { getElementById: () => null, querySelector: () => null,
                    querySelectorAll: () => [], createElement: lavElement,
                    addEventListener() {}, body: lavElement('div') },
        localStorage: { getItem: () => null, setItem() {} },
        Event: LilleEvent,
        confirm: () => true, esc: (x) => String(x),
        parseServerDate: (x) => new Date(x), isOutsideClick: () => false,
    };
    soBox.window = soBox; soBox.globalThis = soBox;
    vm.createContext(soBox);
    // De RIGTIGE filer, i samme rækkefølge som browseren loader dem.
    vm.runInContext(læs('utils.js'), soBox, { filename: 'utils.js' });
    vm.runInContext(læs('mangde_felter.js'), soBox, { filename: 'mangde_felter.js' });
    vm.runInContext(læs('stock_overview.js'), soBox, { filename: 'stock_overview.js' });

    soBox._soConversions = KONV;
    soBox._soQUnitsMap = NAVNE;
    // Enhederne slås op i produkt-kortoteket, ikke på vare-objektet: listen
    // bygges to steder, og felterne ville kunne skride fra hinanden.
    soBox._soProductsMap = {
        1: { id: 1, qu_id_stock: 4, qu_id_purchase: 13, qu_id_consume: 7 },
        2: { id: 2, qu_id_stock: 4, qu_id_purchase: 4, qu_id_consume: 4 },
    };

    const brød = { product_id: 1, name: 'Brød Rug', amount: 117.54, qu_id: 4, qu_name: 'Kilo',
        amount_opened: 0, best_before_date: null, daysUntilExpiry: Infinity, status: 'ok',
        min_stock_amount: 0, alt_conv: [], location_id: 1, product_group_id: 1,
        last_checked: null, last_checked_unit: null, check_interval: null, check: null };
    const enkelt = Object.assign({}, brød, { product_id: 2, name: 'Agurk' });

    eq(soBox._soMfUnits(brød).map(u => u.name).join('/'), 'Kasse/Kilo/stk',
       'Brød Rug kan tælles i tre enheder');
    eq(soBox._soMfUnits(enkelt).length, 1, 'en vare med kun én enhed har kun ét felt');

    const htmlFlere = soBox._soRenderCard(brød);
    const htmlEn = soBox._soRenderCard(enkelt);
    ok(htmlFlere.indexOf('so-mf-host') >= 0, 'flere enheder → felt-vært i panelet');
    ok(htmlFlere.indexOf('<label>') < 0,
       'ingen "Mængde:"-etiket — hvert felt har sin egen enhed over sig');
    ok(htmlFlere.indexOf('type="hidden" class="so-adj-input"') >= 0,
       'summen ligger stadig i so-adj-input — gemme-stien er urørt');
    ok(htmlEn.indexOf('so-mf-host') < 0, 'én enhed → panelet er præcis som før');
    ok(htmlEn.indexOf('Antal:') >= 0, 'med sin gamle etiket');
    ok(htmlEn.indexOf('so-adj-btn') >= 0, 'og sine ± knapper');

    // Det tastede SKAL nå gemme-stien. Sker det ikke, gemmer man det gamle
    // tal uden at noget siger fra — man taster 2 kasser og lageret rører sig
    // ikke. Derfor monteres felterne rigtigt her og tallet aflæses bagefter.
    {
        const host = lavElement('div'); host.className = 'so-mf-host';
        const sumFelt = lavElement('input'); sumFelt.className = 'so-adj-input'; sumFelt.value = '117.54';
        const kort = lavElement('div');
        kort.appendChild(host); kort.appendChild(sumFelt);
        kort.querySelector = (sel) => sel.indexOf('mf-host') >= 0 ? host
                                   : sel.indexOf('adj-input') >= 0 ? sumFelt : null;
        soBox._soContainer = { querySelector: () => kort };
        soBox._soStockData = [brød];

        soBox._soMountMangde(1);
        const felter = host.children[0].children[0].children;   // .mf-wrap > .mf-row > felter
        eq(felter.length, 3, 'tre felter monteret i panelet');
        eq(felter[0].children[1].textContent, 'Kilo',
           'lager-enheden står FØRST — det er den der er forudfyldt, og den man retter');
        eq(felter[0].children[0].value, 117.54,
           'og den er forudfyldt med det der står nu, som ét-felts-panelet altid har været');
        eq(Number(sumFelt.value), 117.54, 'intet tastet endnu → uændret');

        // Der kom to kasser. De LÆGGES TIL det der stod — det er sådan panelet
        // bruges i drift (10 → 11, 117,54 → 118). Var felterne tomme, skulle
        // man tælle hele hylden for at få et plus, og "Kom der varer?" ville
        // aldrig fyre for netop de varer der kommer i kasser.
        felter[1].children[0].skriv('2');
        eq(Number(sumFelt.value), 139.54, '117,54 + 2 × 11 — leverancen lægges til');

        // Skal man i stedet TÆLLE, rydder man lager-feltet.
        felter[0].children[0].skriv('');
        eq(Number(sumFelt.value), 22, 'ryddet lager-felt → kun det talte');
        felter[2].children[0].skriv('25');
        eq(Number(sumFelt.value), 24.25, '2 kasser og 25 stk, talt på hylden');
        eq(soBox._soMfPoster[1]?.length, 2, 'posterne huskes, så en re-render ikke taber dem');

        felter[1].children[0].skriv('');
        felter[2].children[0].skriv('');
        eq(Number(sumFelt.value), 117.54,
           'ryddes ALLE felter, rører vi ikke lagertallet — et tomt panel er ikke "sæt til 0"');

        // Små faktorer må ikke tabe mængde på vejen. _soRound afrunder til 2
        // decimaler = 10 gram når lageret er i kilo; ét-felts-panelet afrunder
        // ikke, så en afrunding her ville være en fejl indført med felterne.
        soBox._soConversions = KONV.concat([{ product_id: 1, from_qu_id: 5, to_qu_id: 4, factor: 0.0081 }]);
        soBox._soProductsMap[1].qu_id_consume = 5;   // Gram
        delete soBox._soMfPoster[1];
        host._attr = {}; host.children = [];          // monter forfra
        soBox._soMountMangde(1);
        const f2 = host.children[0].children[0].children;
        f2[0].children[0].skriv('');                  // ryd lager-feltet: vi TÆLLER
        f2[2].children[0].skriv('3');                 // 3 × 0,0081
        eq(Number(sumFelt.value), 0.0243, 'en lille faktor afrundes ikke væk');
    }

    {
        // Grocy leverer flydende-tal-støj. Æg står som 5,5511151231258e-17 —
        // altså nul, og kortet viser "0 Kilo". Rå > 0 forudfyldte feltet med
        // et tal der i et smalt nummerfelt ser ud som "5.55", mens summen
        // sagde "= 0 Kilo" og delta'en "uændret". Det lignede noget i stykker.
        const æg = Object.assign({}, brød, { product_id: 3, name: 'Æg', amount: 5.5511151231258e-17 });
        soBox._soProductsMap[3] = { id: 3, qu_id_stock: 4, qu_id_purchase: 13, qu_id_consume: 7 };
        const h2 = lavElement('div'); h2.className = 'so-mf-host';
        const s2 = lavElement('input'); s2.className = 'so-adj-input'; s2.value = '0';
        const kort2 = lavElement('div'); kort2.appendChild(h2); kort2.appendChild(s2);
        kort2.querySelector = (sel) => sel.indexOf('mf-host') >= 0 ? h2
                                     : sel.indexOf('adj-input') >= 0 ? s2 : null;
        soBox._soContainer = { querySelector: () => kort2 };
        soBox._soStockData = [æg];
        delete soBox._soMfPoster[3];
        soBox._soMountMangde(3);
        const fÆg = h2.children[0].children[0].children;
        eq(fÆg[0].children[0].value, '', 'nul-støj forudfylder ikke feltet');
    }

    {
        // ± skal ramme det felt man sidst har rørt — ikke altid det første.
        // Forslag fra drift: "pilene skal justere det felt der er i fokus,
        // gerne med en kraftigere kant så man kan se hvad der er i fokus".
        const h3 = lavElement('div'); h3.className = 'so-mf-host';
        const s3 = lavElement('input'); s3.className = 'so-adj-input'; s3.value = '117.54';
        const ned = lavElement('button'); ned.className = 'so-adj-btn'; ned.setAttribute('data-delta', '-1');
        const op  = lavElement('button'); op.className  = 'so-adj-btn'; op.setAttribute('data-delta', '1');
        const kort3 = lavElement('div');
        kort3.appendChild(h3); kort3.appendChild(s3); kort3.appendChild(ned); kort3.appendChild(op);
        soBox._soContainer = { querySelector: () => kort3 };
        soBox._soStockData = [Object.assign({}, brød)];
        delete soBox._soMfPoster[1];
        soBox._soMountMangde(1);

        const rk = h3.find('mf-row')[0];
        const fl = rk.find('mf-field');
        ok(fl[0].classList.contains('so-mf-aktiv'), 'lager-feltet er markeret fra start');
        ok(rk.children.indexOf(ned) === 0, '▼ står forrest i felt-rækken, ikke under den');
        ok(rk.children[rk.children.length - 1] === op, '▲ står bagerst');

        // Rør Kasse-feltet → markeringen flytter med
        (rk._lyt.focusin || []).forEach(fn => fn({ target: fl[1].find('mf-input')[0] }));
        ok(fl[1].classList.contains('so-mf-aktiv'), 'markeringen følger det felt man rører');
        ok(!fl[0].classList.contains('so-mf-aktiv'), 'og kun ét ad gangen');
        ok(/Kasse/.test(op.title), 'pilens tekst siger hvilken enhed den flytter');

        // ± rammer nu Kasse
        soBox._soAdjStep(1, 1);
        eq(fl[1].find('mf-input')[0].value, 1, '▲ flytter det markerede felt');
        eq(fl[0].find('mf-input')[0].value, 117.54, 'og lader de andre være');
    }

    // Wiring: NÅR posterne frem til serveren?
    //
    // Serverens summering er testet for sig (tests/lager_flere_enheder.test.js),
    // men den er ligegyldig hvis klienten aldrig sender posterne med. Uden det
    // her tjek kunne argumentet fjernes uden at én eneste assert faldt, og så
    // ville browserens tal stille og roligt være det der blev gemt igen.
    {
        const kaldt = [];
        soBox.postGrocyInventory = async (pid, amount, bb, entries) => {
            kaldt.push({ pid, amount, entries });
            return { ok: true, new_amount: 15.4005 };
        };
        soBox._soFreshAmount = async () => 117.54;
        soBox._soStampChecked = async () => false;
        soBox._soCloseExpand = () => {};
        soBox._soApplyFilters = () => {};
        soBox._soShowToast = () => {};
        soBox._soSaving = {};
        soBox._soStockData = [Object.assign({}, brød)];
        soBox._soMfPoster[1] = [{ qu_id: 13, qty: 2, factor_used: 7.68 },
                                { qu_id: 7, qty: 5, factor_used: 0.0081 }];
        // Feltets tal og serverens svar er MED VILJE forskellige: ellers kan
        // testen ikke se hvilket af dem der bliver brugt.
        soBox.document.getElementById = (id) =>
            id === 'soAdj-1' ? { value: '99' } : null;

        _ventPaa = soBox._soAdjustInventory(1).then(function() {
            eq(kaldt.length, 1, 'lagerrettelsen sendes');
            eq(kaldt[0].entries?.length, 2, 'MED posterne — ellers summerer serveren aldrig');
            eq(soBox._soStockData[0].amount, 15.4005,
               'og kortet viser det tal SERVEREN gemte, ikke browserens gæt');
            eq(soBox._soMfPoster[1], undefined,
               'posterne ryddes efter gem — næste optælling starter forfra');
        });
    }

    // Wiring: bliver felterne rent faktisk sat i når kortet foldes ud?
    const soKilde = fs.readFileSync(path.join(__dirname, '..', 'shared', 'stock_overview.js'), 'utf8');
    ok(/_soMountMangde\(productId\);/.test(soKilde), 'udfoldning monterer felterne');
    ok(/_soMountMangde\(_soCurrentExpand\)/.test(soKilde),
       'og en re-render sætter dem i igen — ellers står panelet tomt efter en søgning');
}

_ventPaa.then(function() {
    console.log('\n' + '─'.repeat(50));
    console.log(`${pass} PASS · ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
});
