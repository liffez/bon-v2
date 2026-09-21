// scripts/test-supplier-order-lines.js
// ============================================================
// Varelinjen som leverandøren ser den (shared/supplier_order_lines.js).
//
// REGRESSIONEN er Serviwet-scenariet: en vare uden leverandør-varenummer, hvor
// Bon har lavet et internt (INT-0001) for at kunne koble den. Før rettelsen
// skrev bestillingsmailen "(nr. INT-0001)" ud til leverandøren — et tal kun vi
// kender — og linjen bar Grocy-navnet "Burgerlommer", som ikke kan skelne
// 11×11 fra 14×14 cm.
//
// §3 er den vigtigste: mailen og "Kopiér liste" skriver den SAMME bestilling
// til den samme leverandør. De byggede hver sin linje før, så de måles her mod
// hinanden — driver de fra hinanden, fælder det en assert.
//
// §2 rammer den ÆGTE route over HTTP med mailService stubbet i require-cachen;
// et spejl af vareliste-bygningen ville kunne drive fra routen uden at noget
// fejlede. §4 kører den ÆGTE shared/indkob.js i en vm-sandkasse (browser-kode
// kan ikke require'es) og måler hvad der ville blive SENDT, ikke hvad en
// hjælpefunktion returnerer.
//
//   node --experimental-sqlite scripts/test-supplier-order-lines.js
// ============================================================
'use strict';

// Datoen i bekræftelsen formateres i LOKAL tid. Uden en pinnet tidszone ville
// §8's midnats-tilfælde bestå eller fejle efter hvor maskinen står.
process.env.TZ = 'Europe/Copenhagen';

const path = require('path');
const os   = require('os');
const fs   = require('fs');
const vm   = require('vm');
const http = require('http');

const TEST_DB = path.join(os.tmpdir(), `bon-test-sol-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${m}`); c ? pass++ : fail++; };
const eq = (a, b, m) => ok(a === b, `${m} — fik ${JSON.stringify(a)}`);

const S = require('../shared/supplier_order_lines');

/* Fixturen er de tre koblinger der faktisk ligger på Emballage-lokationen i
   grocy-hq, plus den Serviwet-vare opgaven handler om. */
const BURGER_INT = {
    product_name: 'Burgerlommer',
    note: 'Burgerlommer, brune, 11 x 11 cm., pakke af 1.000 stk.',
    barcode: 'INT-0001', quantity: 2, unit: 'stk',
};
const CORNICHON = {
    product_name: 'Cornichoner', note: 'Cornichons, 330 g',
    barcode: '13889531', quantity: 2, unit: 'stk',
};
const FRITEKST = {   // betegnelsen skrevet i NUMMER-feltet (eksisterende praksis)
    product_name: 'Børneboks', note: '',
    barcode: 'Børnebokse hvid m/låg 12x12', quantity: 1, unit: 'stk',
};
const SW_EGET = {    // ligner et internt nummer, men er Serviwets eget
    product_name: 'Kaffelåg', note: 'kaffekopper - Låg',
    barcode: 'SW-2210 kaffelaag 12oz', quantity: 3, unit: 'stk',
};

console.log('\n=== §1 Reglerne ===');
eq(S.supplierLabel(BURGER_INT), 'Burgerlommer, brune, 11 x 11 cm., pakke af 1.000 stk.',
   'betegnelsen er leverandørens note, ikke Grocy-navnet');
eq(S.supplierLabel({ product_name: 'Rugbrød' }), 'Rugbrød',
   'uden note falder vi tilbage på vores eget navn');
eq(S.supplierLabel({ product_name: 'Rugbrød', note: '   ' }), 'Rugbrød',
   'tom note tæller ikke som en betegnelse');
eq(S.supplierLabel({}), 'Ukendt vare', 'ingen af delene → en linje, ikke en tom streng');

eq(S.supplierNumber(BURGER_INT), '', 'vores eget INT-nummer udelades');
eq(S.supplierNumber(CORNICHON), '13889531', 'leverandørens eget nummer kommer med');
eq(S.supplierNumber(SW_EGET), 'SW-2210 kaffelaag 12oz',
   'SW-2210 ligner internt, men er leverandørens — mønstret er smalt med vilje');
eq(S.supplierNumber({ note: 'Cornichons, 330 g', barcode: 'Cornichons, 330 g' }), '',
   'nummer der ER betegnelsen gentages ikke');
eq(S.supplierNumber({ barcode: '  ' }), '', 'tomt nummer giver tom streng');
ok(S.isInternalNumber('INT-0001') && S.isInternalNumber('int-42'),
   'INT-mønstret er versalblindt');
ok(!S.isInternalNumber('INT') && !S.isInternalNumber('INTERN-1') && !S.isInternalNumber('SW-2210'),
   'kun præcis INT-<tal> tæller som vores eget');

eq(S.quantityText({ quantity: 2, unit: 'kasse' }), '2 kasse', 'mængde med enhed');
eq(S.quantityText({ quantity_ordered: 5 }), '5 stk', 'enheden defaulter til stk');
eq(S.quantityText({}), '0 stk', 'manglende mængde bliver 0, ikke undefined');

eq(S.mailLine(BURGER_INT),
   '• Burgerlommer, brune, 11 x 11 cm., pakke af 1.000 stk. — 2 stk',
   'Serviwet-linjen: betegnelse, ingen INT');
eq(S.mailLine(CORNICHON), '• Cornichons, 330 g — 2 stk (nr. 13889531)',
   'Hørkram-linjen beholder nummeret');
ok(S.mailLine(FRITEKST).includes('Børnebokse hvid m/låg 12x12'),
   'fri tekst i nummer-feltet tabes ikke — den står som nummer');
eq(S.mailList([BURGER_INT, CORNICHON]).split('\n').length, 2, 'én linje pr. vare');
eq(S.mailList([]), '', 'tom bestilling giver tom liste, ikke "undefined"');

console.log('\n=== §2 Mailen bygges af modulet (ægte route) ===');
const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);
const { getDb } = require('../db/database');
const db = getDb();

// mailService stubbes FØR routen loades — ellers ville den ægte SMTP-sti køre.
const mailPath = require.resolve('../services/mailService');
let sidsteMail = null;
require.cache[mailPath] = {
    id: mailPath, filename: mailPath, loaded: true, exports: {
        sendFromTemplate: async (args) => { sidsteMail = args; return { threadId: null, messageId: 'x' }; },
    },
};

db.prepare(`INSERT INTO suppliers (id, name, integration_type, contact_email)
            VALUES (5, 'Serviwet', 'email', 'rikke.kjeldsen@serviwet.dk')`).run();
const siteId = db.prepare(`SELECT id FROM locations LIMIT 1`).get().id;

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { userId: 1, userRole: 'admin' }; next(); });
app.use('/api/orders', require('../routes/orders'));

const server = http.createServer(app);

function post(sti, body) {
    return new Promise((res, rej) => {
        const data = JSON.stringify(body);
        const r = http.request({
            host: '127.0.0.1', port: server.address().port, path: sti, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (svar) => {
            let b = ''; svar.on('data', c => b += c);
            svar.on('end', () => res({ status: svar.statusCode, body: b ? JSON.parse(b) : null }));
        });
        r.on('error', rej); r.write(data); r.end();
    });
}

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));

    await post('/api/orders/pending', {
        supplier_id: 5, location_id: siteId, send_email: true,
        expected_delivery_date: '2026-09-25',
        items: [
            { product_id: 1, product_name: 'Burgerlommer', quantity: 2, unit: 'stk',
              barcode: 'INT-0001', varenr: 'INT-0001',
              note: 'Burgerlommer, brune, 11 x 11 cm., pakke af 1.000 stk.' },
            { product_id: 2, product_name: 'Cornichoner', quantity: 2, unit: 'stk',
              barcode: '13889531', varenr: '13889531', note: 'Cornichons, 330 g' },
        ],
    });

    ok(sidsteMail !== null, 'ordremailen blev sendt');
    const liste = sidsteMail && sidsteMail.vars ? sidsteMail.vars.vareliste : '';
    ok(!liste.includes('INT-0001'), 'vores interne nummer står IKKE i mailen til leverandøren');
    ok(liste.includes('Burgerlommer, brune, 11 x 11 cm., pakke af 1.000 stk.'),
       'mailen bærer leverandørens egen betegnelse');
    ok(!/•\s*Burgerlommer\s*—/.test(liste),
       'Grocy-navnet alene står ikke som betegnelse');
    ok(liste.includes('(nr. 13889531)'), 'leverandørens eget nummer er stadig med');
    eq(sidsteMail.to, 'rikke.kjeldsen@serviwet.dk', 'mailen går til leverandørens adresse');

    // Uden note falder linjen tilbage på vores navn — men aldrig på INT-nummeret.
    sidsteMail = null;
    await post('/api/orders/pending', {
        supplier_id: 5, location_id: siteId, send_email: true,
        items: [{ product_id: 3, product_name: 'Servietter', quantity: 1, unit: 'stk',
                  barcode: 'INT-0007', varenr: 'INT-0007' }],
    });
    const liste2 = sidsteMail.vars.vareliste;
    ok(liste2.includes('Servietter'), 'uden note bruges varens navn');
    ok(!liste2.includes('INT-0007'), 'det interne nummer udelades også uden note');

    console.log('\n=== §3 Mail og kopiér-liste er enige ===');
    for (const [navn, vare] of [['Serviwet-vare', BURGER_INT], ['Hørkram-vare', CORNICHON],
                                 ['fri tekst', FRITEKST], ['leverandørens SW-nr', SW_EGET]]) {
        const mail = S.mailLine(vare), kopi = S.copyLine(vare);
        ok(mail.includes(S.supplierLabel(vare)) && kopi.includes(S.supplierLabel(vare)),
           `${navn}: samme betegnelse begge steder`);
        const nr = S.supplierNumber(vare);
        ok(nr ? (mail.includes(nr) && kopi.includes(nr)) : (!mail.includes('nr.') && !kopi.includes('Nr.')),
           `${navn}: samme nummer-beslutning begge steder`);
    }
    ok(S.copyList([CORNICHON], 'Bestilling — Hørkram').startsWith('Bestilling — Hørkram\n'),
       'kopiér-listen beholder sin overskrift');

    console.log('\n=== §4 Klienten (ægte shared/indkob.js) ===');
    const kontekst = lavKlient();

    // Fixture: Serviwet-gruppen (lokation 7) med den interne kobling.
    const bcIntern = { id: 11, barcode: 'INT-0001', note: 'Burgerlommer, brune, 11 x 11 cm., pakke af 1.000 stk.', shopping_location_id: 7 };
    const entry = {
        product: { id: 73, name: 'Burgerlommer' }, qty: 2, needUnit: 'stk',
        matched: true, isOrdered: false, selectedBarcode: bcIntern,
        barcodes: [bcIntern], allItems: [{ id: 501 }],
    };
    kontekst._ibGroups = { '7': { supplierId: 5, displayName: 'Serviwet', items: [entry], integrationType: 'email' } };
    kontekst._ibProducts = { 73: { id: 73, name: 'Burgerlommer', shopping_location_id: 2 } };
    kontekst._ibBarcodes = [bcIntern];

    kontekst._ibCopyOrderList('7');
    const kopieret = kontekst.__kopieret;
    ok(kopieret.includes('Burgerlommer, brune, 11 x 11 cm., pakke af 1.000 stk.'),
       'kopiér-listen bruger betegnelsen');
    ok(!kopieret.includes('INT-0001'), 'kopiér-listen udelader vores interne nummer');
    ok(kopieret.startsWith('Bestilling — Serviwet'), 'overskriften står stadig øverst');

    await kontekst._ibConfirmManualOrder('7', true);
    const sendt = kontekst.__ordre;
    ok(sendt && sendt.items[0].note === bcIntern.note,
       'ordrelinjen bærer noten videre — ellers kan serveren ikke bygge mailen');
    eq(sendt && sendt.items[0].product_id, 73, 'ordrelinjen bærer stadig produkt-id');
    eq(sendt && sendt.items[0].varenr, 'INT-0001',
       'varenr gemmes på ordren — det er kun MAILEN der udelader vores interne numre');

    // Forhåndsvisningen er dét man ser lige før "Send & bestil". Viste den
    // noget andet end mailen sender, kunne man ikke stole på den.
    kontekst.mailIcon = () => '';
    const dlg = kontekst._ibRenderManualDialog(kontekst._ibGroups['7'], '7');
    ok(!dlg.includes('INT-0001'), 'forhåndsvisningen viser ikke vores interne nummer');
    ok(dlg.includes('Burgerlommer, brune, 11 x 11 cm., pakke af 1.000 stk.'),
       'forhåndsvisningen viser leverandørens betegnelse');
    const dlgNr = kontekst._ibRenderManualDialog(
        { displayName: 'Hørkram', contactEmail: null, contactPhone: null,
          items: [{ product: { id: 9, name: 'Cornichoner' }, qty: 2, needUnit: 'stk',
                    matched: true, isOrdered: false,
                    selectedBarcode: { barcode: '13889531', note: 'Cornichons, 330 g' } }] }, '2');
    ok(dlgNr.includes('Nr. 13889531') && dlgNr.includes('Cornichons, 330 g'),
       'forhåndsvisningen beholder leverandørens eget nummer');

    // INT-generatoren: gruppens lokation, ikke produktets default (2).
    kontekst.__oprettet = null;
    await kontekst._ibGenerateIntBarcode(73);
    eq(kontekst.__oprettet && kontekst.__oprettet.shopping_location_id, 7,
       'internt nummer kobles til den gruppe panelet står i, ikke produktets default');
    eq(kontekst.__oprettet && kontekst.__oprettet.note, 'Burgerlommer',
       'internt nummer får en betegnelse med — ellers står mailen med INT-nummeret');
    ok(/^INT-\d+$/.test(kontekst.__oprettet.barcode), 'nummeret følger INT-mønstret');

    console.log('\n=== §5 Rette og gemme en kobling ===');
    const k2 = lavKlient();
    const bc = { id: 11, barcode: 'INT-0001', note: 'gammel tekst', shopping_location_id: 7 };
    const e2 = { product: { id: 73, name: 'Burgerlommer' }, qty: 1, needUnit: 'stk',
                 matched: true, isOrdered: false, selectedBarcode: bc, barcodes: [bc], allItems: [] };
    k2._ibGroups = { '7': { supplierId: 5, displayName: 'Serviwet', items: [e2], integrationType: 'email' } };
    k2._ibProducts = { 73: { id: 73, name: 'Burgerlommer' } };
    k2._ibBarcodes = [bc];

    // Kun teksten rettet — nummeret står. Et tidligt exit på nummeret alene
    // ville kaste rettelsen væk uden en lyd.
    k2.__opdateret = null;
    await k2._ibUpdateVarenr(73, 11, 'INT-0001', 'Burgerlommer, brune, 11 x 11 cm.', null);
    ok(k2.__opdateret !== null, 'rettelse af teksten ALENE bliver gemt');
    eq(k2.__opdateret && k2.__opdateret.body.note, 'Burgerlommer, brune, 11 x 11 cm.',
       'den nye tekst skrives til stregkoden');

    // Begge felter uændrede ⇒ intet at skrive.
    k2.__opdateret = null;
    await k2._ibUpdateVarenr(73, 11, 'INT-0001', 'gammel tekst', null);
    ok(k2.__opdateret === null, 'uændret nummer OG tekst skriver ikke til Grocy');

    // Gem-stien gennem panelets felter: begge læses, noten følger med.
    const k3 = lavKlient({ 'lp-varenr': 'INT-0002', 'lp-note': 'Wok/salat skål LÅG, rund PET' });
    const bc3 = { id: 12, barcode: 'INT-0002', note: '', shopping_location_id: 7 };
    const e3 = { product: { id: 80, name: 'Skållåg' }, qty: 1, needUnit: 'stk',
                 matched: true, isOrdered: false, selectedBarcode: bc3, barcodes: [], allItems: [] };
    k3._ibGroups = { '7': { supplierId: 5, displayName: 'Serviwet', items: [e3], integrationType: 'email' } };
    k3._ibProducts = { 80: { id: 80, name: 'Skållåg' } };
    k3._ibBarcodes = [];
    await k3._ibSaveFreeVarenr(80);
    ok(k3.__oprettet !== null, 'Gem opretter koblingen');
    eq(k3.__oprettet && k3.__oprettet.note, 'Wok/salat skål LÅG, rund PET',
       'bestillingsteksten fra panelet gemmes som note');
    eq(k3.__oprettet && k3.__oprettet.shopping_location_id, 7,
       'koblingen lander på gruppens leverandør');

    // Tomt tekstfelt ⇒ varens navn, så linjen aldrig står uden vare.
    const k4 = lavKlient({ 'lp-varenr': 'INT-0003', 'lp-note': '  ' });
    const bc4 = { id: 13, barcode: 'INT-0003', note: '', shopping_location_id: 7 };
    const e4 = { product: { id: 81, name: 'Nitrilhandsker' }, qty: 1, needUnit: 'stk',
                 matched: true, isOrdered: false, selectedBarcode: bc4, barcodes: [], allItems: [] };
    k4._ibGroups = { '7': { supplierId: 5, displayName: 'Serviwet', items: [e4], integrationType: 'email' } };
    k4._ibProducts = { 81: { id: 81, name: 'Nitrilhandsker' } };
    k4._ibBarcodes = [];
    await k4._ibSaveFreeVarenr(81);
    eq(k4.__oprettet && k4.__oprettet.note, 'Nitrilhandsker',
       'tom tekst falder tilbage på varens navn');

    console.log('\n=== §6 Hvilke varer bestillingen omfatter ===');
    function gruppeMed(markeret) {
        const c = lavKlient();
        const lav = (id, navn, mrk) => ({
            product: { id, name: navn }, qty: 1, needUnit: 'stk',
            matched: true, isOrdered: false, _marked: !!mrk,
            selectedBarcode: { id: id, barcode: 'NR-' + id, note: navn + ' (leverandørens navn)' },
            barcodes: [], allItems: [],
        });
        const items = [lav(1, 'Transportkasser', markeret), lav(2, 'Servietter', false),
                       lav(3, 'Burgerlommer', false), lav(4, 'Nitrilhandsker', false)];
        c._ibGroups = { '7': { supplierId: 5, displayName: 'Serviwet', items,
                               integrationType: 'email', contactEmail: 'rikke@example.invalid' } };
        c._ibProducts = {}; c._ibBarcodes = [];
        c.mailIcon = () => '';
        return c;
    }

    // Drifts-scenariet: ÉN vare markeret. Før gik hele listen afsted.
    const m = gruppeMed(true);
    await m._ibConfirmManualOrder('7', true);
    eq(m.__ordre && m.__ordre.items.length, 1,
       'én markeret vare ⇒ mailen sender ÉN, ikke hele listen');
    eq(m.__ordre && m.__ordre.items[0].product_id, 1, 'og det er den markerede');

    const dlgEn = m._ibRenderManualDialog(m._ibGroups['7'], '7');
    eq((dlgEn.match(/ib-mo-item/g) || []).length, 1,
       'forhåndsvisningen viser det SAMME antal som mailen sender');

    m._ibCopyOrderList('7');
    eq(m.__kopieret.split('\n').length - 1, 1, 'kopiér-listen ligeså');

    // Intet markeret ⇒ alt der er klar.
    const a4 = gruppeMed(false);
    await a4._ibConfirmManualOrder('7', true);
    eq(a4.__ordre && a4.__ordre.items.length, 4, 'intet markeret ⇒ alle klar-varer med');
    const dlg4 = a4._ibRenderManualDialog(a4._ibGroups['7'], '7');
    eq((dlg4.match(/ib-mo-item/g) || []).length, 4, 'og forhåndsvisningen viser de samme fire');

    console.log('\n=== §7 Mailen sendes ikke uden varsel ===');
    const b = gruppeMed(true);
    b.__confirmSvar = false;                      // brugeren siger nej
    await b._ibConfirmManualOrder('7', true);
    eq(b.__ordre, null, 'siger man nej, sendes INTET');
    ok(b.__confirmTekst !== null, 'der blev spurgt');
    ok(String(b.__confirmTekst).includes('rikke@example.invalid'),
       'bekræftelsen siger hvem mailen går til');
    ok(/\b1 vare\b/.test(String(b.__confirmTekst)),
       'og hvor mange varer — det var dét der gik galt');
    ok(String(b.__confirmTekst).includes('Transportkasser'),
       'varerne nævnes ved navn, så man kan se hvad der sendes');
    ok(/kan ikke kaldes tilbage/i.test(String(b.__confirmTekst)),
       'og at den ikke kan fortrydes');

    const c3 = gruppeMed(true);
    c3.__confirmSvar = true;
    await c3._ibConfirmManualOrder('7', true);
    ok(c3.__ordre !== null, 'siger man ja, sendes den');

    // "Bekræft bestilt" går ikke ud af huset og skal ikke spørge.
    const d = gruppeMed(true);
    await d._ibConfirmManualOrder('7', false);
    eq(d.__confirmTekst, null, 'registrering UDEN mail spørger ikke');
    ok(d.__ordre !== null, 'men registrerer stadig');

    console.log('\n=== §8 En fejlbestilling kan rulles tilbage ===');
    function medBestilte(antal, datoer) {
        const c = lavKlient();
        const items = [];
        for (let i = 0; i < antal; i++) {
            const d = datoer ? datoer[i % datoer.length] : '2026-09-21';
            items.push({
                product: { id: 100 + i, name: 'Vare ' + (i + 1) },
                qty: 1, needUnit: 'stk', matched: true, isOrdered: true, _marked: false,
                selectedBarcode: { barcode: 'NR-' + i, note: 'Vare ' + (i + 1) },
                item: { userfields: { ordered_at: d + 'T09:00:00Z', ordered_varenr: 'NR-' + i } },
                barcodes: [], allItems: [{ id: 900 + i }],
            });
        }
        c._ibGroups = { '7': { supplierId: 5, displayName: 'Serviwet', items,
                               integrationType: 'email', contactEmail: 'rikke@example.invalid' } };
        c._ibProducts = {}; c._ibBarcodes = [];
        c.__rullet = [];
        c.updateShoppingListItem = async (id, body) => { c.__rullet.push({ id, body }); };
        return c;
    }

    // Knappen skal ligge på HEADEREN, ikke inde i den kollapsede sektion —
    // ellers skal man først finde og folde noget ud for at komme til den.
    const kilde = fs.readFileSync(path.join(__dirname, '..', 'shared', 'indkob.js'), 'utf8');
    const header = kilde.slice(kilde.indexOf("data-ib=\"toggle-ordered\""),
                               kilde.indexOf("class=\"ib-bs-section"));
    ok(header.includes('data-ib="undo-order-all"'),
       'fortryd-alle sidder på headeren, uden for den kollapsede sektion');

    const u = medBestilte(12);
    await u._ibUndoOrderAll('7');
    eq(u.__rullet.length, 12, 'alle 12 varer rulles tilbage i ÉN handling');
    ok(u.__rullet.every(r => r.body.userfields.ordered_varenr === ''),
       'bestilt-markeringen ryddes — det er den der holder varen ude af listen');
    ok(u.__rullet.every(r => r.body.userfields.ordered_at === ''),
       'og tidsstemplet med');

    const n = medBestilte(5);
    n.__confirmSvar = false;
    await n._ibUndoOrderAll('7');
    eq(n.__rullet.length, 0, 'siger man nej, rulles intet tilbage');
    ok(/kaldes IKKE tilbage/i.test(String(n.__confirmTekst)),
       'bekræftelsen siger at MAILEN ikke annulleres — ellers tror man man har afbestilt');
    ok(/5 bestilte varer/.test(String(n.__confirmTekst)), 'og hvor mange det gælder');

    // Flere datoer i samme gruppe: man må ikke uforvarende rulle gamle med.
    const fl = medBestilte(4, ['2026-09-18', '2026-09-21']);
    fl.__confirmSvar = false;
    await fl._ibUndoOrderAll('7');
    ok(/forskellige dage/i.test(String(fl.__confirmTekst)),
       'bestillinger fra flere dage nævnes i bekræftelsen');

    // ordered_at er UTC. 22:30Z er kl. 00:30 dansk DAGEN EFTER, så en
    // gruppering på ISO-strengens første 10 tegn viser i går (#133). Tidspunktet
    // er pinnet — ellers ville denne assert bestå 22 timer i døgnet.
    const midnat = lavKlient();
    midnat._ibGroups = { '7': { displayName: 'Serviwet', contactEmail: 'x@y.invalid', items: [{
        product: { id: 1, name: 'Vare' }, qty: 1, needUnit: 'stk',
        matched: true, isOrdered: true, selectedBarcode: { barcode: 'NR-1', note: 'Vare' },
        item: { userfields: { ordered_at: '2026-09-21T22:30:00.000Z', ordered_varenr: 'NR-1' } },
        barcodes: [], allItems: [{ id: 901 }],
    }] } };
    midnat._ibProducts = {}; midnat._ibBarcodes = [];
    midnat.updateShoppingListItem = async () => {};
    midnat.__confirmSvar = false;
    await midnat._ibUndoOrderAll('7');
    ok(/22\. sep/.test(String(midnat.__confirmTekst)),
       'bestilt 22:30 UTC vises som 22. sep (dansk), ikke 21.');
    ok(!/21\. sep/.test(String(midnat.__confirmTekst)),
       'og i går nævnes ikke');

    // Dansk dato skifter kl. 02 i UTC. 23:00Z og 01:00Z er derfor 01:00 og
    // 03:00 dansk SAMME nat — én dansk dag, to UTC-datoer. Med .slice(0,10)
    // ville de tælle som "forskellige dage".
    const sammeAften = lavKlient();
    const lav2 = (id, iso) => ({
        product: { id, name: 'Vare ' + id }, qty: 1, needUnit: 'stk',
        matched: true, isOrdered: true, selectedBarcode: { barcode: 'NR-' + id, note: 'Vare' },
        item: { userfields: { ordered_at: iso, ordered_varenr: 'NR-' + id } },
        barcodes: [], allItems: [{ id: 900 + id }],
    });
    sammeAften._ibGroups = { '7': { displayName: 'Serviwet', contactEmail: 'x@y.invalid',
        items: [lav2(1, '2026-09-21T23:00:00.000Z'), lav2(2, '2026-09-22T01:00:00.000Z')] } };
    sammeAften._ibProducts = {}; sammeAften._ibBarcodes = [];
    sammeAften.updateShoppingListItem = async () => {};
    sammeAften.__confirmSvar = false;
    await sammeAften._ibUndoOrderAll('7');
    ok(!/forskellige dage/i.test(String(sammeAften.__confirmTekst)),
       'to bestillinger samme danske nat er ÉN dag, selvom UTC-datoen skifter imellem dem');

    // En delvis rulning må ikke se ud som en hel.
    const d2 = medBestilte(3);
    let kald = 0;
    d2.updateShoppingListItem = async (id, body) => {
        kald++; if (kald === 2) throw new Error('Grocy nede');
        d2.__rullet.push({ id, body });
    };
    await d2._ibUndoOrderAll('7');
    ok(/fejlede/i.test(String(d2.__toast)), 'en delvis rulning siges højt');
    ok(String(d2.__toast).includes('Vare 2'), 'og navngiver den der ikke kom med');

    server.close();
    console.log(`\n${pass} PASS · ${fail} FAIL`);
    try { fs.unlinkSync(TEST_DB); } catch (_) {}
    process.exit(fail ? 1 : 0);
})();

/* ── vm-sandkasse: den ÆGTE indkob.js med stubbede kald udad ──── */
function lavKlient(felter) {
    const el = () => ({
        value: '', innerHTML: '', className: '', style: {},
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener() {}, setAttribute() {}, getAttribute: () => null,
        focus() {}, select() {},
    });
    const ctx = {
        console,
        window: {}, navigator: { clipboard: { writeText: async () => {} } },
        document: { createElement: el, querySelector: () => null, querySelectorAll: () => [],
                    getElementById: () => null, addEventListener() {}, body: el() },
        setTimeout, clearTimeout, Promise, JSON, Math, String, Number, Array, Object, Date, parseInt, parseFloat, isNaN, RegExp,
        SupplierOrderLines: S,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        __kopieret: null, __ordre: null, __oprettet: null,
        __confirmTekst: null, __confirmSvar: true, __toast: null,
    };
    ctx.confirm = (t) => { ctx.__confirmTekst = t; return ctx.__confirmSvar; };
    ctx.window = ctx;
    ctx.navigator.clipboard.writeText = async (t) => { ctx.__kopieret = t; };
    ctx.getSelection = () => ({ rangeCount: 0, isCollapsed: true, toString: () => '' });
    vm.createContext(ctx);
    // utils.js FØRST — indkob.js bruger dens helpers (parseServerDate,
    // grocyProductActive), og siderne loader dem i samme rækkefølge.
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared', 'utils.js'), 'utf8'),
                    ctx, { filename: 'utils.js' });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared', 'indkob.js'), 'utf8'),
                    ctx, { filename: 'indkob.js' });

    // Kald udad — stubbet, så vi måler hvad der ville blive SENDT.
    ctx.createPendingOrder     = async (o) => { ctx.__ordre = o; return { id: 1 }; };
    ctx.createProductBarcode   = async (b) => { ctx.__oprettet = b; return { created_object_id: 99 }; };
    ctx.fetchProductBarcodes   = async () => ctx._ibBarcodes;
    ctx.updateShoppingListItem = async () => {};
    ctx.updateProductBarcode   = async () => {};
    ctx._ibReloadShoppingList  = async () => {};
    ctx._ibBuildGroups         = () => {};
    ctx._ibRender              = () => {};
    ctx._ibEnrichSnapshots     = () => {};
    ctx.updateProductBarcode   = async (id, body) => { ctx.__opdateret = { id, body }; };
    ctx._ibToast               = (t) => { ctx.__toast = t; };
    // Panelets felter, når testen vil gennem den rigtige gem-sti. Uden dem
    // returnerer _ibSaveFreeVarenr tidligt (intet input = intet at gemme).
    ctx._ibContainer = felter ? {
        querySelector(sel) {
            const m = String(sel).match(/data-ib="([^"]+)"/);
            const k = m && m[1];
            return (k && k in felter) ? { value: felter[k], focus() {}, select() {}, innerHTML: '' } : null;
        },
    } : null;
    return ctx;
}
