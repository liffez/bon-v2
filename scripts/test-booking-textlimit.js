// scripts/test-booking-textlimit.js
// ==========================================
// Tegngrænser på bud-tekstens blokke og felter.
//
// Leverandørens formular har felter med en øvre grænse — taxa.nu's besked-felt
// tager 120 tegn, og blokken lander på 111 med almindelige data. Kontoret kan
// ikke se det ved at kigge på en kodeblok, så Bon tæller og markerer.
//
// Vi AFKORTER aldrig: hvad der skal ud er kontorets valg, og et telefonnummer
// klippet væk i stilhed er værre end en tekst man selv forkorter.
//
// Kør med:  node --experimental-sqlite scripts/test-booking-textlimit.js
// ==========================================

const path = require('path');
const os = require('os');
const fs = require('fs');
const vm = require('vm');

const TEST_DB = path.join(os.tmpdir(), `bon-test-textlimit-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const { getDb } = require('../db/database');
const { renderTemplateBlocks, renderFields, buildBookingPayload, boxesText } = require('../services/booking_template');

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  ✓', msg); pass++; }
    else      { console.error('  ✗', msg); fail++; }
}
function assertEqual(actual, expected, msg) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', msg); pass++; }
    else    { console.error('  ✗', msg, '\n      forventet:', expected, '\n      faktisk:  ', actual); fail++; }
}

const VARS = {
    bon_number: 'B4296', total_boxes: '4', company_name: 'Merkur Andelskasse',
    delivery_contact_name: 'Katrine Rosengren Norup', delivery_contact_phone: '+4551621845',
    delivery_time: '11:30', delivery_date: '21-09-2026', pickup_time: '10:45',
    total_boxes_text: '4 kasser',
    packaging_lines: '32× 04 Slider · 6× 06 Emballage',
    delivery_address: 'Vesterbrogade 40, 1620 København V'
};

// ─── 1. renderTemplateBlocks ──────────────────────────────
console.log('\n=== renderTemplateBlocks ===');

const t1 = 'A\nB\n\n{{max:20}}\nkort\n\nC';
const r1 = renderTemplateBlocks(t1, {});
assertEqual(r1.text, 'A\nB\n\nkort\n\nC', 'markør-linjen fjernes fra teksten der kopieres');
assertEqual(r1.blocks.length, 3, 'tre blokke');
assertEqual(r1.blocks[0].maxlen, null, 'blok uden markør har ingen grænse');
assertEqual(r1.blocks[1].maxlen, 20, 'markøren gælder blokken UNDER sig');
assertEqual(r1.blocks[1].length, 4, 'længden er blokkens egen tekst');
assertEqual(r1.blocks[1].over, false, '4 ≤ 20 → ikke over');
assertEqual(r1.blocks[2].maxlen, null, 'grænsen smitter ikke af på næste blok');

// Markøren skal stå FØR blokken. En markør midt i en blok gør ingenting — og
// må i hvert fald ikke lække videre til den næste.
const r1b = renderTemplateBlocks('{{max:20}}\nA\n{{max:30}}\nB\n\nC', {});
assertEqual(r1b.blocks.map(b => b.maxlen), [20, null],
            'markør midt i en blok lækker ikke til næste blok');
assertEqual(renderTemplateBlocks('{{max:20}}\n{{max:30}}\nA', {}).blocks[0].maxlen, 30,
            'to markører i træk: den nærmeste vinder');

const r2 = renderTemplateBlocks('{{max:5}}\nalt for langt', {});
assertEqual(r2.blocks[0].over, true, 'for lang blok markeres');
assertEqual(r2.blocks[0].length, 13, 'og længden siges');
assert(!r2.text.includes('{{max'), 'markøren er ude af teksten');
assertEqual(r2.text, 'alt for langt', 'AFKORTES ALDRIG — hele teksten er der');

// Whitespace er kontorets eget valg og må ikke samles på ny.
const t3 = 'en\n\n\n\nto';
assertEqual(renderTemplateBlocks(t3, {}).text, t3, 'whitespace mellem blokke bevares præcis');

// Markører der ikke giver mening må ikke ændre teksten.
assertEqual(renderTemplateBlocks('{{max:5}}', {}).blocks.length, 0, 'markør uden blok → ingen blok');
assertEqual(renderTemplateBlocks('{{max:5}}\n\nfri', {}).blocks[0].maxlen, null,
            'blank linje efter markøren annullerer den');
const litt = 'tekst {{max:99}} midt i en linje';
assertEqual(renderTemplateBlocks(litt, {}).text, litt, 'markør midt i en linje er almindelig tekst');
assertEqual(renderTemplateBlocks('{{max:abc}}\nx', {}).blocks[0].maxlen, null, 'ugyldigt tal → ingen grænse');
assertEqual(renderTemplateBlocks('  {{ max : 30 }}  \nx', {}).blocks[0].maxlen, 30, 'mellemrum i markøren tolereres');
assertEqual(renderTemplateBlocks(null, {}).blocks, [], 'null → ingen blokke');

// Manglende variabler skal stadig kunne ses pr. blok.
const rm = renderTemplateBlocks('{bon_number}\n\n{delivery_notes}', VARS);
assertEqual(rm.blocks[0].missing, false, 'blok med alt udfyldt: missing=false');
assertEqual(rm.blocks[1].missing, true, 'blok med [mangler]: missing=true');
assert(rm.blocks[1].text.includes('[mangler]'), 'og markeringen står i teksten');

// ─── 1b. "1 kasse" / "4 kasser" ───────────────────────────
// Et bart "1" i en bestilling siger ingenting til den der skal køre. Bøjningen
// hører i koden: "{total_boxes} kasser" i skabelonen ville give "1 kasser".
console.log('\n=== boxesText ===');
assertEqual(boxesText(1), '1 kasse', 'ental');
assertEqual(boxesText(2), '2 kasser', 'flertal');
assertEqual(boxesText(12), '12 kasser', 'to cifre');
assertEqual(boxesText('3'), '3 kasser', 'tal som streng');
assertEqual(boxesText(null), '', 'ingen kasser → tom, så feltet melder [mangler]');
assertEqual(boxesText(0), '', 'nul er ikke "0 kasser"');
assertEqual(boxesText(-1), '', 'negativt → tom');
assertEqual(boxesText('vrøvl'), '', 'vrøvl → tom, ikke NaN');

// ─── 2. Drifts-scenariet: taxas blok mod 120 ──────────────
console.log('\n=== Taxas besked-blok mod de 120 tegn ===');
const TAXA = '{bon_number}. \n{packaging_lines}\n{total_boxes}\n\n\n\n{{max:120}}\n'
           + 'start: {bon_number}, {total_boxes_text} hos Ristet Rug\n'
           + 'lever til {company_name}\n'
           + 'tlf {delivery_contact_name}. {delivery_contact_phone}\n'
           + '{delivery_time}\n\n{delivery_address}\n\n{delivery_date}\n{pickup_time}';
const rt = renderTemplateBlocks(TAXA, VARS);
const besked = rt.blocks[1];
assertEqual(besked.maxlen, 120, 'besked-blokken har grænsen');
assertEqual(besked.length, 113, 'lander på 113 tegn med "4 kasser" og "tlf"');
assertEqual(besked.over, false, '113 ≤ 120 → passer');
assert(besked.text.includes('4 kasser'), 'og ordet står der — ikke et bart "4"');
assert(rt.blocks.some(b => b.text.includes('Vesterbrogade 40')), 'adressen er sin EGEN blok');
assert(!besked.text.includes('Vesterbrogade'), 'og ligger IKKE i den trange besked-blok');

// Et langt kontaktnavn sprænger den — dét er hele grunden til tælleren.
const langt = renderTemplateBlocks(TAXA, { ...VARS,
    delivery_contact_name: 'Katrine Rosengren Norup-Sørensen Bjerregaard' });
assertEqual(langt.blocks[1].over, true, 'langt kontaktnavn → over grænsen, og det siges');
assert(langt.blocks[1].text.includes('+4551621845'), 'telefonnummeret er der stadig — intet klippes væk');

// ─── 3. maxlen på felter ──────────────────────────────────
console.log('\n=== renderFields: maxlen ===');
const v = { booking_fields_json: JSON.stringify([
    { label: 'Fri', template: '{company_name}' },
    { label: 'Snæver', template: '{company_name}', maxlen: 5 },
    { label: 'Rummelig', template: '{company_name}', maxlen: 100 },
    { label: 'Vrøvl', template: '{company_name}', maxlen: 'ti' },
    { label: 'Nul', template: '{company_name}', maxlen: 0 }
]) };
const f = renderFields(v, VARS);
assertEqual(f[0].maxlen, null, 'felt uden maxlen: null');
assertEqual(f[0].over, false, 'og aldrig over');
assertEqual(f[1].maxlen, 5, 'maxlen læses');
assertEqual(f[1].length, 18, 'længden er den RENDEREDE værdi');
assertEqual(f[1].over, true, '18 > 5 → over');
assertEqual(f[1].value, 'Merkur Andelskasse', 'værdien afkortes ikke');
assertEqual(f[2].over, false, '18 ≤ 100 → ikke over');
assertEqual(f[3].maxlen, null, 'ugyldig maxlen ignoreres');
assertEqual(f[4].maxlen, null, 'maxlen 0 er ikke en grænse');

// ─── 4. Payloadet bærer blokkene ──────────────────────────
console.log('\n=== buildBookingPayload: text_blocks ===');
const db = getDb();
const st = db.prepare(`SELECT id FROM status_definitions ORDER BY id LIMIT 1`).get().id;
const lo = db.prepare(`SELECT id FROM locations LIMIT 1`).get().id;
const ad = Number(db.prepare(`INSERT INTO addresses (street_name,street_nr,postal_code,city)
    VALUES ('Vesterbrogade','40','1620','København V')`).run().lastInsertRowid);
const co = Number(db.prepare(`INSERT INTO companies (name) VALUES ('Merkur Andelskasse')`).run().lastInsertRowid);
const cu = Number(db.prepare(`INSERT INTO customers (first_name,last_name,phone)
    VALUES ('Katrine','Rosengren Norup','+4551621845')`).run().lastInsertRowid);
const bonId = Number(db.prepare(`INSERT INTO bons
    (bon_number,status_id,location_id,customer_id,company_id,order_date,delivery_date,
     delivery_time,pickup_time,delivery_type,delivery_address_id,pax,total_units)
    VALUES ('T-TXT',?,?,?,?,'2026-09-19','2026-09-21','11:30','10:45','delivery',?,14,32)`)
    .run(st, lo, cu, co, ad).lastInsertRowid);
db.prepare(`INSERT INTO bon_lines (bon_id,grocy_recipe_id,product_name,category,quantity,unit,unit_price)
    VALUES (?,47,'Transportkasse (emballage)','06 Emballage',4,'stk',10)`).run(bonId);

const taxa = db.prepare(`SELECT id FROM delivery_vehicles WHERE code='taxa-4x35'`).get();
const mig = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '181_taxa_address_and_limit.sql'), 'utf8');

// booking_template seedes IKKE af nogen migration — kontoret har skrevet den i
// hånden i Settings. På en frisk DB er 181 derfor en no-op; det er drift den
// retter. Testen sætter den skabelon der FAKTISK står i drift.
const DRIFT_TEMPLATE = '{bon_number}. \n{packaging_lines}\n{total_boxes}\n\n\n\n'
    + 'start: {bon_number}, {total_boxes} hos Ristet Rug\n'
    + 'lever til {company_name}\n'
    + 'kontakt: {delivery_contact_name}. {delivery_contact_phone}\n'
    + '{delivery_time}\n\n\n{delivery_date}\n{pickup_time}\n\n\n';
db.prepare(`UPDATE delivery_vehicles SET booking_template=? WHERE code='taxa-4x35'`).run(DRIFT_TEMPLATE);
assert(!DRIFT_TEMPLATE.includes('delivery_address'), 'udgangspunkt: driftsskabelonen har INGEN adresse');
db.exec(mig);

const payload = buildBookingPayload(bonId, taxa.id);
assert(Array.isArray(payload.text_blocks), 'payloadet bærer text_blocks');
assert(!(payload.clipboard_text || '').includes('{{max'), 'og clipboard_text er uden markører');
const beskedBlok = (payload.text_blocks || []).find(b => b.maxlen === 120);
assert(beskedBlok, 'migration 181 satte grænsen på besked-blokken');
assertEqual(beskedBlok && beskedBlok.length, 111, 'blokken lander på 111 af 120');
assert((payload.clipboard_text || '').includes('Vesterbrogade 40, 1620 København V'),
       'migration 181 satte ADRESSEN ind — den manglede helt i drift');
const adrBlok = (payload.text_blocks || []).find(b => b.text.includes('Vesterbrogade'));
assert(adrBlok && adrBlok !== beskedBlok, 'og den er sin egen blok, ikke inde i besked-blokken');
const taxaFelter = JSON.parse(db.prepare(`SELECT booking_fields_json j FROM delivery_vehicles WHERE code='taxa-4x35'`).get().j);
assertEqual(taxaFelter.find(f => f.label === 'Bemærkn.').maxlen, 120, 'og felt-visningens Bemærkn. fik samme grænse');

// ─── 5. Migration 181 rører ikke en omskrevet skabelon ────
console.log('\n=== Migration 181: målrettet, ikke overskrivende ===');
const before = db.prepare(`SELECT booking_template FROM delivery_vehicles WHERE code='taxa-4x35'`).get().booking_template;
db.exec(mig);
const after = db.prepare(`SELECT booking_template FROM delivery_vehicles WHERE code='taxa-4x35'`).get().booking_template;
assertEqual(after, before, 'anden kørsel ændrer intet (idempotent)');

db.prepare(`UPDATE delivery_vehicles SET booking_template='helt egen tekst uden ankre' WHERE code='taxa-4x35'`).run();
db.exec(mig);
assertEqual(db.prepare(`SELECT booking_template FROM delivery_vehicles WHERE code='taxa-4x35'`).get().booking_template,
            'helt egen tekst uden ankre', 'en omskrevet skabelon røres ikke');

// To forekomster af ankeret → vi gætter ikke hvilken
db.prepare(`UPDATE delivery_vehicles SET booking_template=? WHERE code='taxa-4x35'`)
  .run('{delivery_date}\n\n{delivery_date}');
db.exec(mig);
assertEqual(db.prepare(`SELECT booking_template FROM delivery_vehicles WHERE code='taxa-4x35'`).get().booking_template,
            '{delivery_date}\n\n{delivery_date}', 'to ankre → migrationen holder sig fra det');

// ─── 6. Popoutet: tælleren må ALDRIG følge med i kopien ───
console.log('\n=== popout: renderClipboard ===');
const noteSrc = fs.readFileSync(path.join(__dirname, '..', 'views', 'delivery', 'note.js'), 'utf8');
const fnSrc = noteSrc.slice(noteSrc.indexOf('    function renderClipboard('),
                            noteSrc.indexOf('    function renderFields('));
// Attrappen registrerer klik-handlere, så vi kan fyre et klik og se hvad der
// FAKTISK bliver kopieret — det er dét der betyder noget, ikke kun markup'en.
const kopieret = [];
const fake = {
    textContent: '', innerHTML: '',
    querySelectorAll(sel) {
        if (sel !== '.dn-block') return [];
        // Ét element pr. dn-block-span i den netop genererede HTML
        return [...String(this.innerHTML).matchAll(/<span class="dn-block(?: over)?" data-block="(\d+)"/g)]
            .map(m => ({
                dataset: { block: m[1] },
                classList: { add() {}, remove() {} },
                _handlers: [],
                addEventListener(_ev, fn) { this._handlers.push(fn); }
            }));
    }
};
const ctx = vm.createContext({
    $clipText: fake,
    esc: x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    copyToClipboard: async t => { kopieret.push(t); return true; },
    showToast: () => {},
    setTimeout: () => {}
});
vm.runInContext(fnSrc + '\n;globalThis._rc = renderClipboard;', ctx);
const rc = ctx._rc;

const blokke = [
    { text: 'kort blok', length: 9, maxlen: null, over: false },
    { text: 'lang blok her', length: 13, maxlen: 120, over: false },
    { text: 'for lang', length: 8, maxlen: 5, over: true }
];
rc('kort blok\n\nlang blok her\n\nfor lang', blokke);
const html = fake.innerHTML;
assert(html.includes('class="dn-block"'), 'blokke renderes som klikbare spans');
assert(html.includes('13/120'), 'tælleren vises for blokke med grænse');
// Tælleren skal ligge UDEN FOR blok-spanet. Ellers følger den med når man
// markerer blokken med musen — og den er ikke en del af bestillingen.
// (non-greedy: stopper ved FØRSTE </span>, så en tæller lagt indeni fanges)
const blokIndhold = [...html.matchAll(/<span class="dn-block(?: over)?"[^>]*>([\s\S]*?)<\/span>/g)]
    .map(m => m[1]);
assertEqual(blokIndhold.length, 3, 'tre blok-spans');
assert(blokIndhold.every(t => !t.includes('dn-block-count')),
       'TÆLLEREN LIGGER UDEN FOR BLOK-SPANET — den kan ikke følge med i kopien');
assertEqual(blokIndhold[1], 'lang blok her', 'blok-spanet rummer KUN blokkens egen tekst');

// Tælleren står OVER blokken — grænsen gælder hele blokken, ikke dens sidste
// linje. Hængt bagpå så den ud som en del af den nederste linje.
const iTaeller = html.indexOf('13/120');
const iBlok = html.indexOf('lang blok her');
assert(iTaeller > -1 && iBlok > -1, 'både tæller og blok er i HTML');
assert(iTaeller < iBlok, 'TÆLLEREN STÅR FØR BLOKKEN');
assert(html.includes('dn-block-count over'), 'overskridelse markeres');
assert(!html.includes('9/'), 'blok uden grænse får ingen tæller');

// Whitespace mellem blokke skal overleve renderingen.
fake.innerHTML = '';
rc('a\n\n\nb', [{ text: 'a', length: 1, maxlen: null, over: false },
                { text: 'b', length: 1, maxlen: null, over: false }]);
assert(fake.innerHTML.includes('</span>\n\n\n<span'), 'whitespace mellem blokke bevares i visningen');

// Ingen blokke (ældre server) → ren tekst, ikke et crash.
fake.textContent = ''; fake.innerHTML = '';
rc('bare tekst', null);
assertEqual(fake.textContent, 'bare tekst', 'uden blokke falder den tilbage til ren tekst');

// ─── 6b. Migration 182: tallet får sit ord ────────────────
console.log('\n=== Migration 182: {total_boxes} → {total_boxes_text} ===');
const mig182 = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '182_taxa_boxes_text.sql'), 'utf8');
db.prepare(`UPDATE delivery_vehicles SET booking_template=? WHERE code='taxa-4x35'`)
  .run('{total_boxes}\n\nstart: X, {total_boxes} hos Ristet Rug');
db.exec(mig182);
const t182 = db.prepare(`SELECT booking_template t FROM delivery_vehicles WHERE code='taxa-4x35'`).get().t;
assertEqual(t182, '{total_boxes_text}\n\nstart: X, {total_boxes_text} hos Ristet Rug',
            'BEGGE forekomster skiftet');
db.exec(mig182);
assertEqual(db.prepare(`SELECT booking_template t FROM delivery_vehicles WHERE code='taxa-4x35'`).get().t,
            t182, 'idempotent — _text bliver ikke til _text_text');

// By-expressens "Antal kolli" skal have det RENE tal, ikke ordet.
const byex = db.prepare(`SELECT booking_fields_json j FROM delivery_vehicles WHERE code='byekspressen'`).get();
assert((byex.j || '').includes('{total_boxes}'), 'By-expressens felt bruger stadig det rene tal');
assert(!(byex.j || '').includes('total_boxes_text'), 'og migrationen rørte ikke den anden vogn');

// ─── 6c. Migration 183: "tlf" sparer plads ────────────────
// "kontakt: " er 9 tegn der ikke siger taxaen noget; "tlf " er 4 og siger det
// samme i den telegramstil blokken allerede har. Fem tegn er meget når der er
// tre tilbage.
console.log('\n=== Migration 183: kontakt: → tlf ===');
const mig183 = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '183_taxa_tlf_label.sql'), 'utf8');
db.prepare(`UPDATE delivery_vehicles SET booking_template=? WHERE code='taxa-4x35'`)
  .run('lever til X\nkontakt: {delivery_contact_name}. {delivery_contact_phone}');
db.exec(mig183);
const t183 = db.prepare(`SELECT booking_template t FROM delivery_vehicles WHERE code='taxa-4x35'`).get().t;
assertEqual(t183, 'lever til X\ntlf {delivery_contact_name}. {delivery_contact_phone}',
            'labelen byttet, navn og nummer urørt');
db.exec(mig183);
assertEqual(db.prepare(`SELECT booking_template t FROM delivery_vehicles WHERE code='taxa-4x35'`).get().t,
            t183, 'idempotent');

// En omskrevet linje røres ikke — det er kontorets tekst.
db.prepare(`UPDATE delivery_vehicles SET booking_template=? WHERE code='taxa-4x35'`)
  .run('ring til {delivery_contact_name}');
db.exec(mig183);
assertEqual(db.prepare(`SELECT booking_template t FROM delivery_vehicles WHERE code='taxa-4x35'`).get().t,
            'ring til {delivery_contact_name}', 'anden formulering → migrationen holder sig fra det');

// Ankeret er HELE 'kontakt: {delivery_contact_name}', ikke bare ordet: et
// "kontakt: " foran fri tekst er kontorets egen formulering og skal stå.
db.prepare(`UPDATE delivery_vehicles SET booking_template=? WHERE code='taxa-4x35'`)
  .run('kontakt: kontoret 33218989');
db.exec(mig183);
assertEqual(db.prepare(`SELECT booking_template t FROM delivery_vehicles WHERE code='taxa-4x35'`).get().t,
            'kontakt: kontoret 33218989', '"kontakt:" foran fri tekst røres IKKE');

// To forekomster af ankeret → vi gætter ikke hvilken der menes.
db.prepare(`UPDATE delivery_vehicles SET booking_template=? WHERE code='taxa-4x35'`)
  .run('kontakt: {delivery_contact_name}\n\nkontakt: {delivery_contact_name}');
db.exec(mig183);
assertEqual(db.prepare(`SELECT booking_template t FROM delivery_vehicles WHERE code='taxa-4x35'`).get().t,
            'kontakt: {delivery_contact_name}\n\nkontakt: {delivery_contact_name}',
            'to ankre → migrationen holder sig fra det');

// Og hvad besparelsen reelt giver: hvor langt må navnet være?
const MK = navn => renderTemplateBlocks(
    '{{max:120}}\nstart: {bon_number}, {total_boxes_text} hos Ristet Rug\n'
    + 'lever til {company_name}\ntlf {delivery_contact_name}. {delivery_contact_phone}\n{delivery_time}',
    { ...VARS, total_boxes_text: '1 kasse', delivery_contact_name: navn }).blocks[0];
assertEqual(MK('Katrine Rosengren Norup').length, 112, 'almindeligt navn (23 tegn) → 112/120');
assertEqual(MK('A'.repeat(31)).length, 120, '31-tegns navn rammer grænsen præcist');
assertEqual(MK('A'.repeat(31)).over, false, 'og 120 er stadig indenfor');
assertEqual(MK('A'.repeat(32)).over, true, '32 tegn sprænger — tælleren siger det');

// ─── 7. Settings må ikke tabe grænsen ─────────────────────
// _dvParseFields læser booking_fields_json ind i editoren. Bevarer den ikke
// maxlen, forsvinder grænsen første gang nogen åbner vognen og trykker Gem —
// en indstilling der falder bort fordi editoren ikke kendte den.
console.log('\n=== settings: maxlen overlever redigering ===');
const stSrc = fs.readFileSync(path.join(__dirname, '..', 'settings', 'index.html'), 'utf8');
const pfSrc = stSrc.slice(stSrc.indexOf('function _dvParseFields('),
                          stSrc.indexOf('\n}', stSrc.indexOf('function _dvParseFields(')) + 2);
const stCtx = vm.createContext({ console });
vm.runInContext(pfSrc + '\n;globalThis._pf = _dvParseFields;', stCtx);
const parsed = stCtx._pf(JSON.stringify([
    { label: 'Bemærkn.', template: '{packaging_lines}', maxlen: 120 },
    { label: 'Fri',      template: '{company_name}' },
    { label: 'Vrøvl',    template: 'x', maxlen: 'ti' }
]));
assertEqual(parsed[0].maxlen, '120', 'maxlen bevares når vognen åbnes til redigering');
assertEqual(parsed[1].maxlen, '', 'felt uden grænse forbliver uden');
assertEqual(parsed[2].maxlen, '', 'vrøvl bliver til tom, ikke NaN');

// Og at felt-editoren faktisk har et maxlen-input at vise den i.
assert(stSrc.includes('dv-field-maxlen'), 'editoren har et felt til grænsen');
assert(stSrc.includes('{{max:120}}'), 'og hjælpeteksten forklarer markøren til samlet tekst');

// Og det vigtigste: hvad kopierer et klik?
(async () => {
console.log('\n=== popout: klik kopierer blokkens egen tekst ===');
fake.innerHTML = ''; kopieret.length = 0;
rc('kort blok\n\nlang blok her', [
    { text: 'kort blok',     length: 9,  maxlen: null, over: false },
    { text: 'lang blok her', length: 13, maxlen: 120,  over: false }
]);
const els = fake.querySelectorAll('.dn-block');
assertEqual(els.length, 2, 'to klikbare blokke');
// Genkør renderingen så handlerne bindes til DISSE elementer
fake.querySelectorAll = () => els;
fake.innerHTML = '';
rc('kort blok\n\nlang blok her', [
    { text: 'kort blok',     length: 9,  maxlen: null, over: false },
    { text: 'lang blok her', length: 13, maxlen: 120,  over: false }
]);
els[1]._handlers.forEach(fn => fn());
await new Promise(r => setImmediate(r));
assertEqual(kopieret, ['lang blok her'],
            'klik kopierer blokkens tekst — uden tæller, uden nabo-blokke');

    console.log(`\n=== Resultat ===\n✓ ${pass} passed,  ✗ ${fail} failed`);
    try { fs.unlinkSync(TEST_DB); } catch {}
    process.exit(fail > 0 ? 1 : 0);
})();
