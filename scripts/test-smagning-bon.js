// scripts/test-smagning-bon.js
// ============================================================
// En booket smagning er en LEVERING, ikke et møde hos os.
//
// Booking-modulet var bygget som "kunden kommer forbi": bekræftelsen sagde
// "Hos os: <vores adresse>", formularen spurgte aldrig hvor kunden var, og
// aftalen endte aldrig i en bon. I virkeligheden pakker køkkenet en smagsprøve
// og vi kører den ud på dagen — så uden en adresse og en bon kan hverken
// kunden, køkkenet eller Logistik gøre deres arbejde.
//
// Reglerne der testes:
//   1. Adressen kræves — men kun for de mødetyper der leveres. Kravet står på
//      mødetypen, ikke i formularen, så en manipuleret POST ikke kan springe
//      det over.
//   2. Bonen oprettes automatisk med den faste smagsprøve, adressen og tiden.
//   3. Bon-oprettelsen er BEST-EFFORT: fejler den, står bookingen stadig, og
//      adressen overlever på aktiviteten så bonen kan laves bagefter fra CRM.
//   4. Den kan ikke laves to gange.
//
// Kør:  node --experimental-sqlite scripts/test-smagning-bon.js
// ============================================================
'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const TEST_DB = path.join(os.tmpdir(), `bon-smagning-${Date.now()}.db`);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

process.env.DB_PATH  = TEST_DB;
process.env.NODE_ENV = 'test';
// Ingen netværk: uden ORS-nøgle kaster routing 'no_api_key', som
// computePickupTime fanger. Sat eksplicit, så en .env på maskinen ikke
// får testen til at ringe ud til ORS.
process.env.ORS_API_KEY = '';

require('../db/migrate').runMigrations(TEST_DB);

const { getDb } = require('../db/database');
const mailService = require('../services/mailService');

// Ingen rigtig post, og stubben skal sidde FØR routes/booking.js indlæses.
mailService.sendFromTemplate = async () => ({ messageId: 'fake', threadId: 1, subject: 'fake' });

// Grocy findes ikke i testmiljøet. Attrappen giver de tre retter smagsprøven
// består af, så linjerne kan efterprøves uden netværk.
const grocy = require('../services/grocyAdapter');
grocy.getRecipes = async () => ([
    { id: 91,  name: 'Slider skinne',  category: '04 Slider',   unit: 'stk', prices: { catering: 180 }, cost_price: 40, co2e: 1.2 },
    { id: 104, name: 'Sandwich i boks', category: '01 Sandwich', unit: 'stk', prices: { catering: 95 },  cost_price: 22, co2e: 0.8 },
    { id: 167, name: 'Cookie knæk',     category: '03 Kager',    unit: 'stk', prices: { catering: 25 },  cost_price: 6,  co2e: 0.2 },
]);

const booking = require('../routes/booking');
const bookingMatcher = require('../services/bookingMatcher');

const db = getDb();
const setSetting = (k, v) => db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);

const settle = () => new Promise(r => setTimeout(r, 150));

// Rækker slås op defensivt: falder en rettelse væk, skal de følgende asserts
// FEJLE rent. En assert der kaster er et dårligere signal end en der fejler —
// den ligner et ødelagt testscript og stopper opsummeringen.
const row = (sql, ...args) => db.prepare(sql).get(...args) || {};

function nextFreeSlot(dateStr) {
    const r = bookingMatcher.computeSlotsForDate(dateStr, 'smagning');
    return (r.slots || []).find(s => s.available) || null;
}
function findDateWithSlot() {
    for (let d = 1; d <= 40; d++) {
        const cand = new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);   // utc-ok: kun til at finde en fremtidig dag
        const s = nextFreeSlot(cand);
        if (s) return { date: cand, slot: s };
    }
    throw new Error('Ingen ledige slots i de næste 40 dage');
}

// BEVIDST en anden adresse end husets egen (Prinsesse Charlottesgade 16).
// Var de ens, kunne testen ikke se forskel på "kundens adresse" og "vores",
// og det er præcis den forveksling fejlen bestod i.
const ADDR = {
    address_street: 'Vesterbrogade',
    address_nr: '10',
    address_zip: '1620',
    address_city: 'København V',
    address_lat: 55.6721,
    address_lon: 12.5560,
};

async function main() {
    const owner = Number(db.prepare(
        `INSERT INTO users (name,email,role,is_active) VALUES ('Anne','anne@ristetrug.invalid','office',1)`
    ).run().lastInsertRowid);

    setSetting('booking_smagning_enabled', '1');
    setSetting('booking_notify_owner_enabled', '0');   // støjer kun her
    setSetting('booking_default_owner_user_id', String(owner));
    setSetting('booking_smagning_menu', JSON.stringify([
        { id: 'r91', count: 1 }, { id: 'r104', count: 2 }, { id: 'r167', count: 1 }
    ]));

    // ── 1) Mødetypen bestemmer om adressen kræves ────────────────────
    console.log('\n1 · Adressekravet står på mødetypen');
    const mtRows = db.prepare('SELECT key, needs_delivery_address FROM meeting_types').all();
    const byKey = Object.fromEntries(mtRows.map(r => [r.key, r.needs_delivery_address]));
    ok(byKey.smagning === 1, 'smagning skal leveres');
    ok(byKey.andet_moede === 0, '"Andet" er en snak og skal ikke have en adresse');

    const { date, slot } = findDateWithSlot();

    const uden = booking.handleSmagningBooking({
        first_name: 'Lærke', email: 'laerke@example.invalid',
        date, time: slot.time, meeting_type: 'smagning'
    });
    ok(uden?.error === 'missing_address', `smagning uden adresse afvises (fik '${uden?.error}')`);
    ok(db.prepare('SELECT COUNT(*) c FROM crm_activities').get().c === 0, 'og der oprettes ingen aftale');

    // ── 2) Med adresse: aftale + bon ─────────────────────────────────
    console.log('\n2 · Booking med adresse giver en bon køkkenet kan pakke');
    const r1 = booking.handleSmagningBooking({
        first_name: 'Lærke', last_name: 'Andersen', email: 'laerke@example.invalid',
        phone: '40195471', date, time: slot.time, meeting_type: 'smagning', ...ADDR
    });
    ok(!!r1?.activityId, `aftalen oprettes (activity #${r1?.activityId})`);
    await settle();

    const act = row('SELECT * FROM crm_activities WHERE id = ?', r1?.activityId ?? -1);
    ok(!!act.delivery_address_id, 'adressen er gemt på aftalen');
    ok(act.guest_count === 2, 'antal gæster kommer fra mødetypen (2), ikke fra formularen');

    const addr = row('SELECT * FROM addresses WHERE id = ?', act.delivery_address_id ?? -1);
    ok(addr?.street_name === 'Vesterbrogade' && addr?.street_nr === '10', 'vej og nummer gemt hver for sig');
    ok(addr?.postal_code === '1620' && addr?.city === 'København V', 'postnr og by gemt');
    ok(Math.abs(addr?.lat - 55.6721) < 0.001, 'koordinater fra autocompleten gemt — ingen DAWA-opslag nødvendigt');

    ok(!!act.bon_id, 'REGRESSIONEN: aftalen har en bon');
    const bon = row('SELECT * FROM bons WHERE id = ?', act.bon_id ?? -1);
    ok(bon?.delivery_date === date, `bonens leveringsdato er bookingens (${bon?.delivery_date})`);
    ok(bon?.delivery_time === slot.time, 'og leveringstiden ligeså');
    ok(bon?.delivery_address_id === act.delivery_address_id, 'bonen peger på SAMME adresse som aftalen');
    ok(bon?.delivery_type === 'delivery', 'den er en levering, ikke en afhentning');
    ok(bon?.customer_id === act.customer_id, 'og den ligger på kunden fra bookingen');
    ok(bon?.pax === 2, 'pax = 2');
    ok(bon?.payment_type === 'sponsorship', `betalingstypen kommer fra indstillingen (fik '${bon?.payment_type}')`);

    const lines = db.prepare('SELECT * FROM bon_lines WHERE bon_id = ? ORDER BY sort_order').all(act.bon_id ?? -1);
    ok(lines.length === 3, `smagsprøvens tre retter er på bonen (fik ${lines.length})`);
    ok(lines[1]?.quantity === 2, 'antallet fra menuen bruges (2 sandwich)');
    ok(lines[0]?.unit_price === 180, 'prisen er snapshottet fra Grocy — den ægte pris bliver stående');
    ok(lines[0]?.grocy_recipe_id === 91, 'linjen er koblet til opskriften');

    // ── 3) Kan ikke laves to gange ───────────────────────────────────
    console.log('\n3 · Samme aftale giver ikke to smagsprøver');
    const { createSmagningBon } = require('../services/smagningBon');
    const again = await createSmagningBon({
        activityId: r1?.activityId ?? -1, customerId: act.customer_id ?? null,
        date, time: slot.time, addressId: act.delivery_address_id, guestCount: 2
    });
    ok(again.created === false && again.reason === 'already_exists', 'anden kørsel opretter ingenting');
    ok(db.prepare('SELECT COUNT(*) c FROM bons').get().c === 1, 'der er stadig kun én bon');

    // ── 4) Grocy nede: bookingen overlever ───────────────────────────
    console.log('\n4 · Grocy nede må ikke koste kunden hendes booking');
    const realGetRecipes = grocy.getRecipes;
    grocy.getRecipes = async () => { throw new Error('Grocy API fejl 401'); };

    const { date: d2, slot: s2 } = findDateWithSlot();
    const r2 = booking.handleSmagningBooking({
        first_name: 'Morten', email: 'morten@example.invalid',
        date: d2, time: s2.time, meeting_type: 'smagning', ...ADDR
    });
    ok(!!r2?.activityId, 'bookingen lykkes stadig');
    await settle();
    const act2 = row('SELECT * FROM crm_activities WHERE id = ?', r2?.activityId ?? -1);
    ok(!!act2.bon_id, 'bonen oprettes alligevel — adressen og tiden er det køkkenet skal bruge først');
    const bon2 = row('SELECT internal_notes FROM bons WHERE id = ?', act2.bon_id ?? -1);
    ok(db.prepare('SELECT COUNT(*) c FROM bon_lines WHERE bon_id = ?').get(act2.bon_id ?? -1).c === 0, 'men uden linjer');
    ok(/Grocy/i.test(bon2?.internal_notes || ''), 'og grunden står på bonen, så ingen tror der ligger mad klar');
    grocy.getRecipes = realGetRecipes;

    // ── 5) Menuen ikke sat op ────────────────────────────────────────
    console.log('\n5 · Menu ikke sat op');
    setSetting('booking_smagning_menu', '[]');
    const { date: d3, slot: s3 } = findDateWithSlot();
    const r3 = booking.handleSmagningBooking({
        first_name: 'Ida', email: 'ida@example.invalid',
        date: d3, time: s3.time, meeting_type: 'smagning', ...ADDR
    });
    await settle();
    const act3 = row('SELECT bon_id FROM crm_activities WHERE id = ?', r3?.activityId ?? -1);
    const bon3 = row('SELECT internal_notes FROM bons WHERE id = ?', act3.bon_id ?? -1);
    ok(/ikke sat op/i.test(bon3?.internal_notes || ''), 'bonen siger at menuen mangler i Settings');
    setSetting('booking_smagning_menu', JSON.stringify([{ id: 'r91', count: 1 }]));

    // ── 6) Auto-oprettelse kan slås fra — og så er der en vej tilbage ─
    console.log('\n6 · Slået fra i Settings → bonen laves fra CRM bagefter');
    setSetting('booking_smagning_create_bon', '0');
    const { date: d4, slot: s4 } = findDateWithSlot();
    const r4 = booking.handleSmagningBooking({
        first_name: 'Jonas', email: 'jonas@example.invalid',
        date: d4, time: s4.time, meeting_type: 'smagning', ...ADDR
    });
    await settle();
    const act4 = row('SELECT * FROM crm_activities WHERE id = ?', r4?.activityId ?? -1);
    ok(!act4.bon_id, 'ingen bon når auto-oprettelsen er slået fra');
    ok(!!act4.delivery_address_id, 'men adressen er gemt, så bonen kan laves bagefter');

    setSetting('booking_smagning_create_bon', '1');
    const manuel = await createSmagningBon({
        activityId: act4.id, customerId: act4.customer_id,
        date: d4, time: s4.time, addressId: act4.delivery_address_id,
        guestCount: act4.guest_count, meetingTypeLabel: 'Smagning'
    });
    ok(manuel.created === true, 'og den kan laves manuelt bagefter');
    const act4b = row('SELECT bon_id FROM crm_activities WHERE id = ?', act4.id ?? -1);
    ok(act4b.bon_id === manuel.bonId, 'aftalen peger nu på den');

    // ── 7) Bekræftelsen fortæller hvor vi leverer ────────────────────
    console.log('\n7 · Bekræftelsen siger hvor vi leverer hen');
    const tmpl = row(`SELECT body_text FROM mail_templates WHERE key = 'booking_smagning_confirmation'`);
    ok(!(tmpl?.body_text || '').includes('Hos os:'), 'skabelonen inviterer ikke længere kunden ind til os');
    ok((tmpl?.body_text || '').includes('{{leveringsAdresse}}'), 'den viser leveringsadressen');

    const KUNDE_ADR = 'Vesterbrogade 10, 1620 København V';
    const vars = bookingMatcher.buildSmagningMailVars({
        customerId: act.customer_id ?? null, meetingType: { label: 'Smagning', duration_min: 10 },
        date, time: slot.time, deliveryAddress: KUNDE_ADR
    });
    ok(vars.leveringsAdresse === KUNDE_ADR, 'adressen når frem til skabelonen');
    ok(vars.firmaAdresse && vars.leveringsAdresse !== vars.firmaAdresse,
        `og det er KUNDENS adresse, ikke husets (vores: '${vars.firmaAdresse}')`);

    // Hele vejen igennem: den adresse der blev gemt, er den der står i mailen.
    const gemt = row('SELECT * FROM addresses WHERE id = ?', act.delivery_address_id ?? -1);
    ok([gemt.street_name, gemt.street_nr].join(' ') + ', ' + [gemt.postal_code, gemt.city].join(' ') === KUNDE_ADR,
        'og den stemmer med det der blev gemt ved bookingen');

    // ── 8) Settings må kun tilbyde variabler mailen faktisk fylder ──
    //
    // renderTemplate lader en ukendt {{variabel}} stå som LITERAL tekst. En chip
    // der ikke svarer til noget sender derfor "{{totalPris}}" ordret ud til
    // kunden — samme fejlklasse som {{booking_link}} gjorde fra bon-mailen.
    // Booking-skabelonerne faldt tilbage på bon-sættet, som intet af dem fylder.
    console.log('\n8 · Variabel-chips i Settings passer til skabelonerne');
    const vm2 = require('vm');
    const html = fs.readFileSync(path.join(__dirname, '..', 'settings', 'index.html'), 'utf8');
    const mv = html.match(/var TEMPLATE_VARS = \{[\s\S]*?\n\};/);
    ok(!!mv, 'TEMPLATE_VARS kunne læses ud af Settings');
    const TV = mv ? vm2.runInNewContext(mv[0] + '\n;TEMPLATE_VARS') : {};

    // tag injiceres af sendFromTemplate, booking_link af renderTemplate —
    // ingen af dem kommer fra en vars-builder.
    const UNIVERSELLE = new Set(['tag', 'booking_link']);

    const faktiske = {
        booking_smagning_confirmation: bookingMatcher.buildSmagningMailVars({
            customerId: act.customer_id ?? null, meetingType: { label: 'x', duration_min: 1 },
            date, time: slot.time, deliveryAddress: 'x'
        }),
        booking_smagning_reminder: bookingMatcher.buildReminderVars({
            due_at: date + ' 09:00:00', duration_min: 10, customer_id: act.customer_id ?? null,
            first_name: 'x', last_name: 'y', email: 'z@x.invalid', meeting_label: 'Smagning'
        }),
        booking_kontakt_confirmation: bookingMatcher.buildKontaktMailVars({
            customerId: act.customer_id ?? null, contactReason: { label: 'x' }
        }),
        booking_internal_notification: bookingMatcher.buildInternalNotificationVars({
            customerId: act.customer_id ?? null, flow: 'smagning',
            meetingType: { label: 'x' }, date, time: slot.time, formData: {}, viaToken: true
        }),
    };

    for (const [key, vars] of Object.entries(faktiske)) {
        const chips = TV[key];
        ok(Array.isArray(chips), `${key} har sit eget chip-sæt (falder ikke tilbage på bon-sættet)`);
        const ukendte = (chips || []).filter(v => !UNIVERSELLE.has(v) && !(v in vars));
        ok(ukendte.length === 0, `${key}: ingen chips uden en værdi — ellers sendes de ordret ud (fandt: ${ukendte.join(', ') || 'ingen'})`);
    }

    // ── 9) Retter vælges med den FÆLLES vareliste ───────────────────
    //
    // Smagsprøvens indhold blev først bygget med en hjemmelavet <select> —
    // en tredje måde at vælge en ret på, ved siden af bon-draweren og
    // event-modalen. Folk skal møde den samme gestus hvert sted, og en
    // separat vælger driver fra de andre uden at nogen opdager det.
    console.log('\n9 · Smagsprøvens menu bruger den fælles VarePicker');
    ok(/src="\.\.\/shared\/vare_picker\.js"/.test(html), 'Settings loader shared/vare_picker.js');
    ok(/href="\.\.\/shared\/vare_picker\.css"/.test(html), 'og dens CSS');

    const pickerBlok = (html.match(/function bsInitSmagningPicker\(\)[\s\S]*?\n}/) || [''])[0];
    ok(/new VarePicker\(/.test(pickerBlok), 'menuen bygges med VarePicker');
    ok(/bonId:\s*null/.test(pickerBlok), 'i detached mode — den POSTer ikke selv (samme som event-modalen)');
    ok(/onAdded:/.test(pickerBlok), 'og leverer linjen via onAdded');

    // Den hjemmelavede vælger må ikke ligge tilbage ved siden af.
    ok(!/id="bs-smagning-pick"/.test(html), 'den gamle <select> er væk');
    ok(!/function bsSmagningAdd\(/.test(html), 'og dens tilføj-handler ligeså');

    // ── 10) Takkesiden siger det samme som mailen ───────────────────
    //
    // Den sagde "Adresse: {{firmaAdresse}}" — vores adresse, ikke kundens — og
    // siden hardkodede variablen til tom streng, så linjen stod bare som
    // "Adresse:" uden noget efter. Telefonnummeret ligeså.
    console.log('\n10 · Takkesiden');
    const ty = row(`SELECT body_text b FROM page_templates WHERE key = 'thankyou_smagning'`).b || '';
    ok(!/\{\{firmaAdresse\}\}/.test(ty), 'takkesiden viser ikke længere VORES adresse');
    ok(/\{\{leveringsAdresse\}\}/.test(ty), 'men leveringsadressen');

    const form = fs.readFileSync(path.join(__dirname, '..', 'booking', 'smagning.html'), 'utf8');
    const tvFn = (form.match(/function buildThankyouVars\([\s\S]*?\n}/) || [''])[0];
    ok(!/firmaTelefon:\s*''/.test(tvFn), 'telefonnummeret er ikke længere hardkodet tomt');
    ok(/state\.contact\?\.phone/.test(tvFn), 'det hentes fra /meeting-types');
    ok(/leveringsAdresse:\s*data\.address_text/.test(tvFn), 'og leveringsadressen fra det kunden tastede');

    // Alle variabler takkesiden bruger skal kunne fyldes af siden.
    const tyVars = [...ty.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
    const tomme = tyVars.filter(v => new RegExp(v + ":\\s*''").test(tvFn));
    ok(tomme.length === 0, `ingen af takkesidens variabler er hardkodet tomme (fandt: ${tomme.join(', ') || 'ingen'})`);

    // ── 11) Bonens status ───────────────────────────────────────────
    //
    // NY betyder "nogen skal tage stilling". En booket smagning er afklaret i
    // det sekund kunden trykker book — menu, adresse og tid er alle givne — så
    // den hører ikke til i NY-bunken sammen med de bestillinger der faktisk
    // mangler noget.
    console.log('\n11 · Bonens status');
    const stDefault = row(`SELECT value v FROM settings WHERE key = 'booking_smagning_bon_status'`).v;
    ok(stDefault === 'GODKENDT', `standard er GODKENDT (fik '${stDefault}')`);

    const st1 = row(`SELECT sd.code c FROM bons b JOIN status_definitions sd ON sd.id = b.status_id WHERE b.id = ?`,
                    act.bon_id ?? -1).c;
    ok(st1 === 'GODKENDT', `REGRESSIONEN: bonen fra bookingen er ikke NY (fik '${st1}')`);

    // Vil man se dem igennem først, sættes VENTER — derfor en indstilling.
    setSetting('booking_smagning_bon_status', 'VENTER');
    const { date: d9, slot: s9 } = findDateWithSlot();
    const r9 = booking.handleSmagningBooking({
        first_name: 'Sofie', email: 'sofie@example.invalid',
        date: d9, time: s9.time, meeting_type: 'smagning', ...ADDR
    });
    await settle();
    const act9 = row('SELECT bon_id FROM crm_activities WHERE id = ?', r9?.activityId ?? -1);
    const st2 = row(`SELECT sd.code c FROM bons b JOIN status_definitions sd ON sd.id = b.status_id WHERE b.id = ?`,
                    act9.bon_id ?? -1).c;
    ok(st2 === 'VENTER', `indstillingen slår igennem (fik '${st2}')`);

    // En tastefejl i Settings må ikke koste bonen: getStatusId() giver
    // undefined for en ukendt kode, og så ville INSERT'en kaste.
    setSetting('booking_smagning_bon_status', 'VRØVL');
    const { date: d10, slot: s10 } = findDateWithSlot();
    const r10 = booking.handleSmagningBooking({
        first_name: 'Mads', email: 'mads@example.invalid',
        date: d10, time: s10.time, meeting_type: 'smagning', ...ADDR
    });
    await settle();
    const act10 = row('SELECT bon_id FROM crm_activities WHERE id = ?', r10?.activityId ?? -1);
    ok(!!act10.bon_id, 'en ukendt status i Settings koster IKKE bonen');
    const st3 = row(`SELECT sd.code c FROM bons b JOIN status_definitions sd ON sd.id = b.status_id WHERE b.id = ?`,
                    act10.bon_id ?? -1).c;
    ok(st3 === 'NY', `den falder tilbage til NY (fik '${st3}')`);
    setSetting('booking_smagning_bon_status', 'GODKENDT');

    // ── 12) Vi kører den selv ud ────────────────────────────────────
    //
    // Uden vognen står bonen som "Ikke planlagt endnu" i Logistik og på
    // køkkenkortet, og nogen skal huske at vælge den i hånden hver gang.
    console.log('\n12 · Vognen sættes automatisk');
    const volvo = row(`SELECT id, code FROM delivery_vehicles
                        WHERE type = 'volvo' AND is_internal = 1 AND is_active = 1
                        ORDER BY sort_order, id LIMIT 1`);
    const vehSetting = row(`SELECT value v FROM settings WHERE key = 'booking_smagning_vehicle_id'`).v;
    ok(!!volvo.id, 'der findes en intern volvo-vogn i stamdata');
    ok(vehSetting === String(volvo.id),
       `migrationen slog den op på type, ikke på et hårdkodet id (fik '${vehSetting}')`);

    const bonVeh = row(`SELECT delivery_vehicle_id v, delivery_method m, courier_provider p
                          FROM bons WHERE id = ?`, act.bon_id ?? -1);
    ok(bonVeh.v === volvo.id, `REGRESSIONEN: bonen har vognen på sig (fik '${bonVeh.v}')`);
    ok(bonVeh.m === 'volvo', `delivery_method synkroniseret, så lister og filtre ser den (fik '${bonVeh.m}')`);
    ok(bonVeh.p === volvo.code, 'courier_provider ligeså');

    const ev = row(`SELECT event_type t, vehicle_id v FROM delivery_events WHERE bon_id = ?`, act.bon_id ?? -1);
    ok(ev.t === 'booked' && ev.v === volvo.id, 'og der ligger et booking-event, så historikken kan læses');

    // "Book ikke automatisk" er et gyldigt valg.
    setSetting('booking_smagning_vehicle_id', '');
    const { date: d11, slot: s11 } = findDateWithSlot();
    const r11 = booking.handleSmagningBooking({
        first_name: 'Ea', email: 'ea@example.invalid',
        date: d11, time: s11.time, meeting_type: 'smagning', ...ADDR
    });
    await settle();
    const act11 = row('SELECT bon_id FROM crm_activities WHERE id = ?', r11?.activityId ?? -1);
    const bon11 = row('SELECT delivery_vehicle_id v FROM bons WHERE id = ?', act11.bon_id ?? -1);
    ok(!!act11.bon_id && bon11.v == null, 'tom indstilling = ingen vogn, og bonen laves stadig');

    // En vogn der er slettet må ikke kunne vælte bonen — og må ikke være tavs.
    setSetting('booking_smagning_vehicle_id', '99999');
    const { date: d12, slot: s12 } = findDateWithSlot();
    const r12 = booking.handleSmagningBooking({
        first_name: 'Bo', email: 'bo@example.invalid',
        date: d12, time: s12.time, meeting_type: 'smagning', ...ADDR
    });
    await settle();
    const act12 = row('SELECT bon_id FROM crm_activities WHERE id = ?', r12?.activityId ?? -1);
    ok(!!act12.bon_id, 'en ukendt vogn koster ikke bonen');
    const bon12 = row('SELECT internal_notes n FROM bons WHERE id = ?', act12.bon_id ?? -1);
    ok(/BESTIL BUD/.test(bon12.n || ''), 'og grunden står på bonen med anvisningen — ikke i stilhed');
    setSetting('booking_smagning_vehicle_id', String(volvo.id || ''));

    // Uden en vej til at ændre dem i Settings ville begge kræve SQL.
    ok(/id="bs-smagning-status"[\s\S]{0,160}booking_smagning_bon_status/.test(html),
       'Settings har en status-vælger koblet til den rigtige indstilling');
    ok(/id="bs-smagning-vehicle"[\s\S]{0,160}booking_smagning_vehicle_id/.test(html),
       'og en vogn-vælger ligeså');
    ok(/Book ikke automatisk/.test(html), 'med "book ikke" som et synligt valg');
    ok(/fetchStatuses\(\), fetchDeliveryVehicles\(\)/.test(html),
       'listerne hentes fra API — ingen hårdkodet kopi af statusser eller vogne');

    // Og blokken skal kunne RENDERE. En grep ser ikke en exception (fx en
    // helper der ikke findes i scope), og så ville hele sektionen være tom.
    const vm = require('node:vm');
    const src = (html.match(/function _smagningBonBlock\(\)[\s\S]*?\n}/) || [''])[0];
    const sandbox = {
        esc: x => String(x ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
        allSettings: {
            booking_smagning_create_bon: '1',
            booking_smagning_bon_status: 'VENTER',
            booking_smagning_vehicle_id: String(volvo.id),
        },
        _smagningPayTypes: [{ code: 'sponsorship', label: 'Sponsorat', counts_as_revenue: 0 }],
        _smagningPriceCats: [{ code: 'catering', label: 'Catering' }],
        _smagningStatuses: [{ code: 'NY', label: 'Ny', category: 'normal' },
                            { code: 'VENTER', label: 'Venter info', category: 'normal' },
                            { code: 'GODKENDT', label: 'Godkendt', category: 'normal' }],
        _smagningVehicles: [{ id: volvo.id, label: 'Volvo Duett', is_internal: 1 },
                            { id: volvo.id + 100, label: 'By-expressen', is_internal: 0 }],
    };
    let blok = '';
    try {
        vm.createContext(sandbox);
        vm.runInContext(src + '\n_smagningBonBlock();', sandbox);
        blok = vm.runInContext('_smagningBonBlock()', sandbox);
    } catch (err) {
        blok = `RENDER-FEJL: ${err.message}`;
    }
    ok(!/RENDER-FEJL/.test(blok), `blokken renderer uden at kaste (${blok.slice(0, 80)})`);
    ok(/<option value="VENTER" selected>Venter info<\/option>/.test(blok),
       'den gemte status står som valgt');
    ok(new RegExp('<option value="' + volvo.id + '" selected>Volvo Duett').test(blok),
       'og den gemte vogn ligeså');
    ok(/egen vogn/.test(blok) && /By-expressen(?! \u2014 egen vogn)/.test(blok),
       'egne vogne er mærket, så man kan se hvad der er vores');

    // ── 13) Office kan SE at det er en smagsprøve ───────────────────
    //
    // I bon-listen lignede den en helt almindelig ordre. Forklaringen
    // ("standard smagsprøve") står i køkkeninfo, men listen viser ikke det
    // felt — så office havde ingen måde at se det på.
    //
    // Rammer den ÆGTE /api/bons-forespørgsel over HTTP. Et spejl af SQL'en
    // her i testen kunne drive fra routen uden at én eneste assert faldt.
    console.log('\n13 · Office-listen mærker den som en booket smagsprøve');
    const express = require('express');
    const app = express();
    app.use('/api/bons', require('../routes/bons'));
    const srv = await new Promise(res => { const x = app.listen(0, () => res(x)); });
    const port = srv.address().port;

    // Kontrolprøve: en ganske almindelig bon på samme dag må IKKE få mærket.
    const { createBon } = require('../db/helpers');
    const almindelig = createBon({
        customer_id: act.customer_id, delivery_date: date,
        delivery_type: 'delivery', status_code: 'NY',
    });

    const listRes = await fetch(`http://127.0.0.1:${port}/api/bons?date=${date}&limit=200`);
    const listen = listRes.ok ? await listRes.json() : [];
    srv.close();

    ok(Array.isArray(listen) && listen.length > 0, `listen svarer (${listRes.status}, ${listen.length} rækker)`);
    const smagsBon = listen.find(r => r.id === act.bon_id) || {};
    const almBon   = listen.find(r => r.id === almindelig.bonId) || {};

    ok(smagsBon.booking_meeting_label === 'Smagning',
       `REGRESSIONEN: smagsprøve-bonen bærer mødetypens navn (fik '${smagsBon.booking_meeting_label}')`);
    ok(!!smagsBon.booking_meeting_emoji, 'og mødetypens emoji, så mærket kan ses på afstand');
    ok(almBon.id === almindelig.bonId && almBon.booking_meeting_label == null,
       'mens en almindelig bon på samme dag IKKE mærkes');

    // Mærket er data-drevet, ikke et hårdkodet ord: ellers ville det lyve
    // den dag en anden mødetype begynder at give en bon.
    // Chippen bygges af en ren funktion, så den kan KALDES. En grep på filen
    // kan ikke se forskel på levende og død kode — en `if (false)` omkring
    // rendering ville bestå en tekst-test og vise ingenting i browseren.
    const listJs = fs.readFileSync(path.join(__dirname, '..', 'office', 'views', 'bons-list.js'), 'utf8');
    const chipSrc = (listJs.match(/function _blBookingChip\(bon\)[\s\S]*?\n}/) || [''])[0];
    const chipBox = {
        esc: x => String(x ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    };
    let chipOn = '', chipOff = '';
    try {
        vm.createContext(chipBox);
        vm.runInContext(chipSrc, chipBox);
        chipBox.__b = smagsBon;
        chipOn  = vm.runInContext('_blBookingChip(__b)', chipBox);
        chipOff = vm.runInContext('_blBookingChip({ bon_number: "B1" })', chipBox);
    } catch (err) {
        chipOn = `RENDER-FEJL: ${err.message}`;
    }
    ok(/bl-booking-chip/.test(chipOn) && /Smagning/.test(chipOn),
       `listen bygger faktisk mærket (fik '${String(chipOn).slice(0, 70)}')`);
    ok(chipOff === '', 'og en bon uden booking får intet mærke');

    // Rækken rendrer også chippen — funktionen må ikke ligge ubrugt.
    ok(/\+ _blBookingChip\(bon\)/.test(listJs), 'og rækken bruger den');

    const css = fs.readFileSync(path.join(__dirname, '..', 'office', 'index.html'), 'utf8');
    ok(/\.bl-booking-chip\s*\{/.test(css), 'der findes en stil til det — ellers er mærket usynligt');

    console.log(`\n${'─'.repeat(52)}`);
    console.log(`  ${pass} PASS · ${fail} FAIL`);
    try { fs.unlinkSync(TEST_DB); } catch {}
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); try { fs.unlinkSync(TEST_DB); } catch {}; process.exit(1); });
