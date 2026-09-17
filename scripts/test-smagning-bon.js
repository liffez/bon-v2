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

    console.log(`\n${'─'.repeat(52)}`);
    console.log(`  ${pass} PASS · ${fail} FAIL`);
    try { fs.unlinkSync(TEST_DB); } catch {}
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); try { fs.unlinkSync(TEST_DB); } catch {}; process.exit(1); });
