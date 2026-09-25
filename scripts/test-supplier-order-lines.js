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
const ægteMail = require('../services/mailService');
let sidsteMail = null;
const mailStub = { sidsteRaa: null };
require.cache[mailPath] = {
    id: mailPath, filename: mailPath, loaded: true, exports: {
        sendFromTemplate: async (args) => { sidsteMail = args; return { threadId: null, messageId: 'x' }; },
        sendMail: async (args) => { mailStub.sidsteRaa = args; return { threadId: null, messageId: 'y' }; },
        // Kladden renderes med de ÆGTE funktioner — det er hele pointen at den
        // viser det samme som afsendelsen ville producere.
        renderTemplate: ægteMail.renderTemplate,
        applySignature: ægteMail.applySignature,
    },
};

db.prepare(`INSERT INTO suppliers (id, name, integration_type, contact_email)
            VALUES (5, 'Serviwet', 'email', 'rikke.kjeldsen@serviwet.dk')`).run();
// Kladden skal vise hele mailen, altså også signaturen.
const signatur = 'Venlig hilsen\nRistet Rug';
db.prepare(`INSERT INTO settings (key, value) VALUES ('mail_signature', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(signatur);
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

    console.log('\n=== §2b Mailen som kladde ===');
    function postSvar(sti, body) { return post(sti, body); }

    // §2 har lige sendt — nulstil, ellers måler "kladden sender ingenting" intet.
    sidsteMail = null; mailStub.sidsteRaa = null;

    const kl = await postSvar('/api/orders/pending/mail-draft', {
        supplier_id: 5,
        items: [
            { product_id: 1, product_name: 'Burgerlommer', quantity: 2, unit: 'stk',
              barcode: 'INT-0001', note: 'Burgerlommer, brune, 11 x 11 cm., pakke af 1.000 stk.' },
            { product_id: 2, product_name: 'Cornichoner', quantity: 2, unit: 'stk',
              barcode: '13889531', note: 'Cornichons, 330 g' },
        ],
    });
    eq(kl.status, 200, 'kladden hentes');
    eq(kl.body.to, 'rikke.kjeldsen@serviwet.dk', 'den viser hvem mailen går til');
    eq(kl.body.item_count, 2, 'og hvor mange varer');
    ok(kl.body.body.includes('Burgerlommer, brune, 11 x 11 cm., pakke af 1.000 stk.'),
       'brødteksten bærer varelisten efter SAMME regel som afsendelsen');
    ok(!kl.body.body.includes('INT-0001'), 'og udelader vores interne numre');
    ok(!/#po-/.test(kl.body.subject),
       'emnet bærer INTET svar-mærke — det kan slettes ved et uheld i et redigerbart felt');
    ok(sidsteMail === null && mailStub.sidsteRaa === null,
       'kladden sender ingenting — hverken gennem skabelonen eller råt');
    ok(kl.body.body.includes(signatur),
       'kladden bærer signaturen, så den viser HELE mailen');

    // Kladden må ikke skrive noget: ingen ordre, ingen mail.
    const foerOrdrer = db.prepare('SELECT COUNT(*) n FROM purchase_orders').get().n;
    await postSvar('/api/orders/pending/mail-draft', { supplier_id: 5, items: [] });
    eq(db.prepare('SELECT COUNT(*) n FROM purchase_orders').get().n, foerOrdrer,
       'kladden opretter ingen ordre');

    const udenMail = await postSvar('/api/orders/pending/mail-draft', { supplier_id: 999, items: [] });
    eq(udenMail.status, 404, 'ukendt leverandør giver en fejl, ikke en tom kladde');

    // Den RETTEDE tekst er den der sendes — ikke skabelonen renderet forfra.
    sidsteMail = null;
    await postSvar('/api/orders/pending', {
        supplier_id: 5, location_id: siteId, send_email: true,
        email_subject: 'Bestilling — haster',
        email_body: 'Hej Rikke,\n\nKan I levere onsdag?\n\n• Transportkasser — 4 stk\n\nMvh Leif',
        items: [{ product_id: 1, product_name: 'Transportkasser', quantity: 4, unit: 'stk',
                  barcode: 'INT-0009', note: 'Transportkasser, brune' }],
    });
    ok(sidsteMail === null, 'rettet kladde går IKKE gennem skabelon-stien');
    const raa = mailStub.sidsteRaa;
    ok(raa !== null, 'men mailen blev sendt');
    ok(!!raa && raa.text.includes('Kan I levere onsdag?'),
       'det kontoret skrev, er det der sendes');
    ok(!!raa && !raa.text.includes('Hermed bestilling fra Ristet Rug'),
       'skabelonens egen tekst er IKKE med — den blev jo rettet væk');
    eq(raa && raa.subject, 'Bestilling — haster', 'og emnet er kontorets');
    eq(raa && raa.appendSignature, false,
       'signaturen lægges ikke på igen — kladden bar den, og den kan være rettet');
    ok(!!raa && !!raa.context && raa.context.type === 'purchase_order',
       'svar-mærket sættes på ved afsendelse, hvor ordre-id findes');

    // Uden rettet tekst: skabelonen som før.
    sidsteMail = null; mailStub.sidsteRaa = null;
    await postSvar('/api/orders/pending', {
        supplier_id: 5, location_id: siteId, send_email: true,
        items: [{ product_id: 1, product_name: 'Servietter', quantity: 1, unit: 'stk',
                  barcode: '111', note: 'Servietter, 33x33' }],
    });
    ok(sidsteMail !== null, 'uden kladde bruges skabelonen som hidtil');
    eq(mailStub.sidsteRaa, null, 'og den rå sti røres ikke');

    console.log('\n=== §2c Modtageren kan rettes for denne ene bestilling ===');
    sidsteMail = null; mailStub.sidsteRaa = null;
    await postSvar('/api/orders/pending', {
        supplier_id: 5, location_id: siteId, send_email: true,
        email_subject: 'Emne', email_body: 'Tekst',
        email_to: 'bogholderi@serviwet.dk',
        items: [{ product_id: 1, product_name: 'Handsker', quantity: 1, unit: 'stk', barcode: '1' }],
    });
    eq(mailStub.sidsteRaa && mailStub.sidsteRaa.to, 'bogholderi@serviwet.dk',
       'den rettede adresse er den mailen går til');
    const afvig = db.prepare(
        `SELECT old_value, new_value FROM changelog
          WHERE entity_type='purchase_order' AND field_name='email_to' ORDER BY id DESC LIMIT 1`).get();
    ok(!!afvig, 'afvigelsen står i historikken — ellers kan ingen svare på hvor mailen gik hen');
    eq(afvig && afvig.old_value, 'rikke.kjeldsen@serviwet.dk', 'med leverandørens faste adresse');
    eq(afvig && afvig.new_value, 'bogholderi@serviwet.dk', 'og den der blev brugt');

    // Samme adresse som leverandørens er ikke en afvigelse.
    const foerLog = db.prepare(
        `SELECT COUNT(*) n FROM changelog WHERE entity_type='purchase_order' AND field_name='email_to'`).get().n;
    await postSvar('/api/orders/pending', {
        supplier_id: 5, location_id: siteId, send_email: true,
        email_subject: 'Emne', email_body: 'Tekst',
        email_to: 'rikke.kjeldsen@serviwet.dk',
        items: [{ product_id: 1, product_name: 'Handsker', quantity: 1, unit: 'stk', barcode: '1' }],
    });
    eq(db.prepare(`SELECT COUNT(*) n FROM changelog WHERE entity_type='purchase_order' AND field_name='email_to'`).get().n,
       foerLog, 'den faste adresse noteres ikke som en afvigelse');

    // En tastefejl må ikke gå til SMTP.
    sidsteMail = null; mailStub.sidsteRaa = null;
    await postSvar('/api/orders/pending', {
        supplier_id: 5, location_id: siteId, send_email: true,
        email_subject: 'Emne', email_body: 'Tekst', email_to: 'rikke.serviwet.dk',
        items: [{ product_id: 1, product_name: 'Handsker', quantity: 1, unit: 'stk', barcode: '1' }],
    });
    eq(mailStub.sidsteRaa, null, 'en ugyldig adresse sendes ikke');
    eq(sidsteMail, null, 'heller ikke gennem skabelon-stien');

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

    console.log('\n=== §6b Kladde-teksten når serveren ===');
    const kt = gruppeMed(true);
    await kt._ibConfirmManualOrder('7', true,
        { subject: 'Bestilling — haster', body: 'Hej Rikke,\n\nKan I levere onsdag?' });
    eq(kt.__ordre && kt.__ordre.email_subject, 'Bestilling — haster',
       'det rettede emne sendes med');
    eq(kt.__ordre && kt.__ordre.email_body, 'Hej Rikke,\n\nKan I levere onsdag?',
       'og den rettede brødtekst — ellers renderer serveren skabelonen forfra');
    eq(kt.__confirmTekst, null,
       'og der spørges ikke igen: man har lige læst og rettet hele mailen');

    const kta = gruppeMed(true);
    await kta._ibConfirmManualOrder('7', true,
        { subject: 'E', body: 'T', to: 'anden@example.invalid' });
    eq(kta.__ordre && kta.__ordre.email_to, 'anden@example.invalid',
       'den rettede modtager sendes med');

    // Uden kladde (ældre kaldevej) bæres intet med, og der spørges.
    const uk = gruppeMed(true);
    await uk._ibConfirmManualOrder('7', true);
    eq(uk.__ordre && uk.__ordre.email_subject, undefined, 'uden kladde sendes intet emne med');
    ok(uk.__confirmTekst !== null, 'og bekræftelsen er der stadig');

    console.log('\n=== §6c "Send & bestil" åbner kladden ===');
    const mo = gruppeMed(true);
    mo.__kladdeKald = null;
    mo.fetchOrderMailDraft = async (arg) => {
        mo.__kladdeKald = arg;
        return { to: 'rikke@example.invalid', supplier_name: 'Serviwet', item_count: 1,
                 subject: 'Bestilling', body: 'Hej Rikke,\n\n• Transportkasser — 1 stk' };
    };
    mo._ibMailOrder('7');
    await new Promise(r => setTimeout(r, 20));
    ok(mo.__kladdeKald !== null, '"Send & bestil" henter kladden');
    eq(mo.__ordre, null, 'og sender INGENTING før man har læst og trykket Send');
    eq(mo.__confirmTekst, null, 'der vises heller ingen ja/nej-boks — kladden ER valget');
    eq(mo.__kladdeKald && mo.__kladdeKald.items.length, 1,
       'kladden bygges på det samme udvalg som afsendelsen');

    console.log('\n=== §6d Mere af en vare der allerede er bestilt ===');
    function medLinjer(linjer) {
        const c = lavKlient();
        c._ibProducts = { 50: { id: 50, name: 'Nitrilhandsker', shopping_location_id: 7, qu_id_stock: 1 } };
        c._ibQUnits = { 1: { id: 1, name: 'Antal' } };
        c._ibLocations = { 7: { id: 7, name: 'Emballage' } };
        c._ibHandelssteder = [{ grocy_location_id: 7, supplier_id: 5, supplier_name: 'Serviwet',
                                integration_type: 'email', contact_email: 'rikke@example.invalid' }];
        c._ibProductGroups = {};
        c._ibBarcodes = [{ id: 1, product_id: 50, barcode: '4711', note: 'Nitrilhandsker, æske af 100 stk',
                           shopping_location_id: 7, userfields: {} }];
        c._ibShoppingList = linjer;
        c.__byg();
        const g = c._ibGroups['7'];
        return { c, e: g && g.items.find(x => x.product.id === 50) };
    }
    const bestiltUF = { ordered_at: '2026-09-21T09:00:00Z', ordered_varenr: '4711',
                        ordered_qty: '10', ordered_supplier: 'Serviwet' };

    // Drifts-scenariet: 10 bestilt, 10 nye lagt på.
    const blandet = medLinjer([
        { id: 1, product_id: 50, amount: 10, userfields: bestiltUF },
        { id: 2, product_id: 50, amount: 10, userfields: {} },
    ]);
    ok(!!blandet.e, 'varen findes i gruppen');
    eq(blandet.e && blandet.e.isOrdered, false,
       'en vare med en ÅBEN linje er ikke bestilt — ellers kan man ikke bestille mere');
    eq(blandet.e && blandet.e.need, 10,
       'behovet er kun det åbne — summeres begge, bestiller man de gamle 10 igen');

    const alleAabne = medLinjer([
        { id: 1, product_id: 50, amount: 10, userfields: {} },
        { id: 2, product_id: 50, amount: 5, userfields: {} },
    ]);
    eq(alleAabne.e && alleAabne.e.isOrdered, false, 'ingen linjer bestilt ⇒ åben');
    eq(alleAabne.e && alleAabne.e.need, 15, 'og behovet er summen');

    const alleBestilte = medLinjer([
        { id: 1, product_id: 50, amount: 10, userfields: bestiltUF },
        { id: 2, product_id: 50, amount: 5, userfields: bestiltUF },
    ]);
    eq(alleBestilte.e && alleBestilte.e.isOrdered, true, 'alle linjer bestilt ⇒ bestilt');
    eq(alleBestilte.e && alleBestilte.e.need, 15, 'og det samlede vises');

    // Bestilling må kun røre de åbne linjer — ellers overskrives den gamle
    // bestillings dato og varenummer, og sporet af den forsvinder.
    const bl = blandet.c;
    bl.__rullet = [];
    bl.updateShoppingListItem = async (id, body) => { bl.__rullet.push({ id, body }); };
    bl.fetchShoppingList = async () => bl._ibShoppingList;
    await bl._ibConfirmManualOrder('7', true, { subject: 'Emne', body: 'Tekst' });
    eq(bl.__rullet.length, 1, 'kun ÉN linje markeres — den der ikke allerede var bestilt');
    eq(bl.__rullet[0] && bl.__rullet[0].id, 2, 'og det er den åbne');

    console.log('\n=== §6e Et fremmed varenummer må ikke i bestillingen ===');
    // Drifts-scenariet: `Gafler` stod under Serviwet med KUN en Hørkram-kobling,
    // og Hørkrams nummer røg med i mailen til Serviwet.
    function medKoblinger(koblinger, produktLok) {
        const c = lavKlient();
        c._ibProducts = { 60: { id: 60, name: 'Gafler', shopping_location_id: produktLok, qu_id_stock: 1 } };
        c._ibQUnits = { 1: { id: 1, name: 'Antal' } };
        c._ibLocations = { 2: { id: 2, name: 'Hørkram' }, 7: { id: 7, name: 'Emballage' },
                           9: { id: 9, name: 'Convifood' } };
        // Hørkram dækker BÅDE lokation 2 og 9 — det er hele pointen.
        c._ibHandelssteder = [
            { grocy_location_id: 2, supplier_id: 1, supplier_name: 'Hørkram', integration_type: 'api' },
            { grocy_location_id: 9, supplier_id: 1, supplier_name: 'Hørkram', integration_type: 'api' },
            { grocy_location_id: 7, supplier_id: 5, supplier_name: 'Serviwet', integration_type: 'email',
              contact_email: 'rikke@example.invalid' },
        ];
        c._ibProductGroups = {};
        c._ibBarcodes = koblinger;
        c._ibShoppingList = [{ id: 1, product_id: 60, amount: 20, userfields: {} }];
        c.__byg();
        const g = c._ibGroups[String(produktLok)];
        return { c, g, e: g && g.items.find(x => x.product.id === 60) };
    }
    const HK = { id: 1, product_id: 60, barcode: '18281705', note: 'Gaffel flergangsplast PP', shopping_location_id: 2, userfields: {} };
    const SW = { id: 2, product_id: 60, barcode: 'INT-0020', note: 'Gafler, Serviwet', shopping_location_id: 7, userfields: {} };

    // 1) Kun Hørkrams nummer, men varen står under Serviwet
    const kun = medKoblinger([HK], 7);
    eq(kun.e && kun.e.foreignBarcode, true,
       'nummeret er en ANDEN leverandørs — det ses på varen');
    eq(S.supplierNumber(kun.c._ibOrderItem(kun.e)), '',
       'og det kommer IKKE med i bestillingen til Serviwet');
    ok(S.supplierLabel(kun.c._ibOrderItem(kun.e)).includes('Gaffel'),
       'betegnelsen bærer stadig linjen — varen kan bestilles uden nummer');

    // 2) Begge numre: Serviwets vælges, selvom Hørkrams står først
    const begge = medKoblinger([HK, SW], 7);
    eq(begge.e && begge.e.selectedBarcode && begge.e.selectedBarcode.barcode, 'INT-0020',
       'har vi et nummer hos leverandøren selv, er det DET der vælges');
    eq(begge.e && begge.e.foreignBarcode, false, 'og så er der intet fremmed at advare om');

    // 3) Foretrukket hos en ANDEN leverandør må ikke vinde
    const favHK = Object.assign({}, HK, { userfields: { is_preferred: '1' } });
    const favner = medKoblinger([favHK, SW], 7);
    eq(favner.e && favner.e.selectedBarcode && favner.e.selectedBarcode.barcode, 'INT-0020',
       'leverandøren vinder over "foretrukket" — et nummer hos den forkerte er ikke bedre');

    // 4) Hørkram dækker flere handelssteder: et Hørkram-nummer på en
    //    Convifood-vare er RIGTIGT, for det er samme leverandør.
    const convi = medKoblinger([HK], 9);
    eq(convi.e && convi.e.foreignBarcode, false,
       'samme leverandør på tværs af handelssteder er ikke fremmed');
    eq(S.supplierNumber(convi.c._ibOrderItem(convi.e)), '18281705',
       'og nummeret kommer med');

    // Advarslen skal SES — en tavs udeladelse er lige så svær at forstå som
    // det fremmede nummer var.
    const raekke = kun.c._ibRenderItem(kun.e, kun.g, false);
    ok(/ib-foreign-nr/.test(raekke), 'varerækken bærer en advarsel');
    ok(/Hørkram/.test(raekke), 'og navngiver hvis nummer det er');
    ok(/kommer ikke med i bestillingen/.test(raekke), 'og siger hvad konsekvensen er');
    ok(/open-link/.test(raekke), 'med en vej til at koble varen hos den rigtige');
    const renRaekke = kun.c._ibRenderItem(begge.e, begge.g, false);
    ok(!/ib-foreign-nr/.test(renRaekke), 'og den vises ikke når nummeret er leverandørens eget');

    // 5) Vi gætter ikke: uden leverandør på gruppen markeres intet
    const uden = medKoblinger([HK], 99);
    eq(uden.e && uden.e.foreignBarcode, false,
       'en gruppe uden leverandør giver ingen advarsel — vi markerer kun det vi kan se');

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
    // Lige rig nok til at kladde-dialogen kan bygges: den appender et overlay
    // til body og slår sine felter op med [data-ib-md="..."].
    const el = () => {
        const felter = {};
        return {
            value: '', innerHTML: '', className: '', style: {},
            children: [],
            appendChild(c) { this.children.push(c); return c; },
            removeChild(c) { this.children = this.children.filter(x => x !== c); return c; },
            querySelector(sel) {
                const m = String(sel).match(/data-ib-md="([^"]+)"/);
                if (!m) return null;
                if (!felter[m[1]]) felter[m[1]] = { value: '', focus() {}, select() {} };
                return felter[m[1]];
            },
            querySelectorAll: () => [],
            addEventListener() {}, removeEventListener() {},
            setAttribute() {}, getAttribute: () => null,
            focus() {}, select() {},
        };
    };
    const ctx = {
        console,
        window: {}, navigator: { clipboard: { writeText: async () => {} } },
        document: { createElement: el, querySelector: () => null, querySelectorAll: () => [],
                    getElementById: () => null, addEventListener() {}, removeEventListener() {},
                    body: el() },
        setTimeout, clearTimeout, Promise, JSON, Math, String, Number, Array, Object, Date, parseInt, parseFloat, isNaN, RegExp,
        SupplierOrderLines: S,
        InvoicePrice: require(path.join(__dirname, '..', 'shared', 'invoice_price')),
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
    // Den ÆGTE gruppering gemmes: §6d tester den, og en stub ville skjule
    // netop den funktion testen handler om.
    ctx.__byg                  = ctx._ibBuildGroups;
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
