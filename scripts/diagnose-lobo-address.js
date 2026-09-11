// scripts/diagnose-lobo-address.js — READ-ONLY diagnose. Skriver INTET.
// ════════════════════════════════════════════════════════════════════════
// Svarer på: hvilken adresse sendte vi til Byekspressen (Lobo) for en bon,
// og hvordan så den ud da Lobo havde modtaget og opløst den?
//
// Tre afsnit:
//   1) Adressen som den står i Bon v2 (addresses-tabellen, rå felter)
//   2) Den PRÆCISE JSON-body vi POSTer til Lobo — genopbygget med
//      produktionskoden (composeLoboBooking → buildOrderPayload)
//   3) Lobos EGET svar på bookingen (delivery_events.snapshot_json):
//      ordre-uuid, ordrenummer og leverings-stoppets adressefelter som
//      Lobo gemte dem. Det er dét Byekspressen skal debugge ud fra.
//
//   node --experimental-sqlite scripts/diagnose-lobo-address.js --bon B4223
//   node --experimental-sqlite scripts/diagnose-lobo-address.js --bon B4223 --live
//
// --live henter ordren igen fra Lobo (GET /orders/{uuid}) og viser hvordan
// den ser ud NU. Kræver Lobo-creds i .env. Uden flaget bruges kun DB.
// ════════════════════════════════════════════════════════════════════════
'use strict';
try { require('dotenv').config(); } catch { /* .env valgfri — afsnit 1-3 læser kun DB */ }
const path = require('path');
const { openDb } = require('../db/compat');
const { bonToOrderInput, createByExpressenAdapter } = require('../services/byExpressenAdapter');
const { composeLoboBooking } = require('../services/lobo_booking');

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const has = (k) => argv.includes(k);

const bonArg = arg('--bon');
if (!bonArg) {
    console.error('Brug: node --experimental-sqlite scripts/diagnose-lobo-address.js --bon B4223 [--live]');
    process.exit(2);
}

const J = (o) => JSON.stringify(o, null, 2);
const line = (c = '─') => console.log(c.repeat(72));

(async () => {
    const db = openDb(path.join(__dirname, '..', 'data', 'bon.db'));

    // Find bonen — accepterer både bon_number ("B4223"/"4223") og rå id.
    const bon = db.prepare(
        `SELECT b.*, sd.code AS status_code
           FROM bons b LEFT JOIN status_definitions sd ON sd.id = b.status_id
          WHERE b.bon_number = ? OR b.bon_number = ? OR b.id = ? LIMIT 1`
    ).get(bonArg, bonArg.replace(/^#?B?/i, ''), parseInt(bonArg.replace(/\D/g, ''), 10) || -1);

    if (!bon) { console.error(`Fandt ingen bon "${bonArg}".`); process.exit(1); }

    console.log(`\n╔══ Bon ${bon.bon_number}  (id ${bon.id})  ·  levering ${bon.delivery_date} ${String(bon.delivery_time || '').slice(0, 5)}`);
    console.log(`╚══ status ${bon.status_code}  ·  leveringsmetode ${bon.delivery_method || '—'}\n`);

    /* ── 1) ADRESSEN I BON v2 ─────────────────────────────────────── */
    line('═');
    console.log('1. ADRESSEN SOM DEN STÅR I BON v2  (tabellen `addresses`)');
    line('═');
    const addr = bon.delivery_address_id
        ? db.prepare('SELECT * FROM addresses WHERE id = ?').get(bon.delivery_address_id)
        : null;
    if (!addr) {
        console.log('  ⚠ Bonen har INGEN leveringsadresse (delivery_address_id er tom).\n');
    } else {
        for (const k of ['id', 'label', 'street_name', 'street_name2', 'street_nr', 'postal_code', 'city', 'lat', 'lon']) {
            console.log(`  ${k.padEnd(14)} ${addr[k] === null || addr[k] === '' ? '(tom)' : JSON.stringify(addr[k])}`);
        }
        console.log('');
    }

    /* ── 2) DET VI SENDER TIL LOBO ────────────────────────────────── */
    line('═');
    console.log('2. DEN JSON-BODY VI POSTer TIL LOBO  (POST /orders)');
    line('═');

    const bonFull = { ...bon, delivery_address: addr || {} };
    // Kontaktnavn/-tlf som bonToOrderInput bruger dem.
    const cust = bon.customer_id
        ? db.prepare(`SELECT first_name, last_name, phone FROM customers WHERE id = ?`).get(bon.customer_id)
        : null;
    if (cust) {
        bonFull.contact_name_full = [cust.first_name, cust.last_name].filter(Boolean).join(' ');
        bonFull.contact_phone = cust.phone;
    }

    const vehicle = db.prepare(
        `SELECT * FROM delivery_vehicles WHERE code = 'byekspressen'`
    ).get();

    console.log('\n  → Adresse-delen alene (bonToOrderInput — rå felt-mapping):');
    console.log(J(bonToOrderInput(bonFull).delivery).split('\n').map(l => '    ' + l).join('\n'));

    // Config = vognens booking_api_config_json. buildOrderPayload er en REN
    // funktion, så den fulde body kan bygges uden Lobo-credentials.
    let cfg = null;
    try {
        cfg = vehicle && vehicle.booking_api_config_json
            ? JSON.parse(vehicle.booking_api_config_json) : null;
        if (!cfg) console.log('\n  (vognen `byekspressen` mangler booking_api_config_json)');
    } catch (e) {
        console.log(`\n  (ugyldig booking_api_config_json på vognen — ${e.message})`);
    }

    if (cfg) {
        const adapter = createByExpressenAdapter({
            config: cfg,
            credentials: { user: 'x', pass: 'x' },   // bruges ikke — vi kalder kun builderen
            fetchImpl: async () => { throw new Error('ingen netværk i dette script'); },
        });
        const paxPerBox = Number(db.prepare(`SELECT value FROM settings WHERE key = 'pax_per_box'`).get()?.value) || 16;
        const { input } = composeLoboBooking(bonFull, vehicle, cfg, { paxPerBox });
        console.log('\n  → HELE bodyen (som den POSTes til Lobo):');
        console.log(J(adapter.buildOrderPayload(input)).split('\n').map(l => '    ' + l).join('\n'));
        console.log('\n  NB: dette er en GENSKABNING ud fra bonens nuværende data.');
        console.log('      Er adressen rettet efter bookingen, afviger den fra det sendte.');
        console.log('      Afsnit 3 er sandheden om hvad Lobo modtog.');
    }
    console.log('');

    /* ── 3) HVAD LOBO SVAREDE ─────────────────────────────────────── */
    line('═');
    console.log('3. HVAD LOBO FAKTISK MODTOG OG GEMTE  (`delivery_events.snapshot_json`)');
    line('═');

    const events = db.prepare(
        `SELECT id, event_type, external_reference, event_time, notes, snapshot_json
           FROM delivery_events
          WHERE bon_id = ? AND provider = 'byekspressen'
          ORDER BY id ASC`
    ).all(bon.id);

    if (!events.length) {
        console.log('  ⚠ Ingen By-expressen-events på bonen. Blev den booket via popout (manuel) i stedet?\n');
    }

    for (const ev of events) {
        console.log(`\n  ── event #${ev.id}  ${ev.event_type}  ${ev.event_time}`);
        if (ev.external_reference) console.log(`     Lobo ordre-uuid: ${ev.external_reference}`);
        if (ev.notes) console.log(`     note: ${ev.notes}`);
        if (!ev.snapshot_json) { console.log('     (intet snapshot)'); continue; }

        let snap = null;
        try { snap = JSON.parse(ev.snapshot_json); } catch { console.log('     (snapshot kunne ikke parses)'); continue; }

        console.log(`     ordrenummer:     ${snap.numberformatted || '—'}`);
        console.log(`     status:          ${snap.status || '—'}`);
        console.log(`     reference:       ${snap.customerreferenceorder || '—'}`);
        console.log(`     routedistance:   ${snap.routedistance ?? '—'} m`);

        const stops = Array.isArray(snap.stops) ? snap.stops : [];
        const del = stops.find(s => s.position === 2) || stops[stops.length - 1];
        if (!del) { console.log('     (ingen stops i snapshot)'); continue; }

        console.log('\n     LEVERINGS-STOP som Lobo gemte det:');
        for (const k of ['street', 'housenumber', 'addition', 'suffix', 'hnr_add_sfx',
                         'zip', 'city', 'isocode', 'fkplace', 'placetype', 'name',
                         'contactperson', 'notepublic', 'trackingnumber']) {
            if (del[k] !== undefined) {
                console.log(`       ${k.padEnd(16)} ${del[k] === null || del[k] === '' ? '(tom)' : JSON.stringify(del[k])}`);
            }
        }
    }
    console.log('');

    /* ── 4) VALGFRIT: HENT ORDREN LIVE ────────────────────────────── */
    if (has('--live')) {
        line('═');
        console.log('4. ORDREN HENTET LIVE FRA LOBO  (GET /orders/{uuid})');
        line('═');
        const uuid = [...events].reverse().find(e => e.event_type === 'booked' && e.external_reference)?.external_reference;
        if (!uuid) {
            console.log('  Ingen booket ordre-uuid at slå op.\n');
        } else {
            try {
                const { getByExpressenAdapter } = require('../services/byExpressenAdapter');
                const adapter = getByExpressenAdapter({ db });
                const order = await adapter.getOrder(uuid);
                console.log(J(order).split('\n').map(l => '  ' + l).join('\n'));
            } catch (e) {
                console.log(`  Kunne ikke hente: ${e.message}\n`);
            }
        }
    }

    line('═');
    console.log('Til Byekspressen: afsnit 2 = det vi sender, afsnit 3 = det I gemte.');
    console.log('Ordre-uuid og ordrenummer i afsnit 3 er nøglen til jeres egne logs.');
    line('═');
    console.log('');
})();
