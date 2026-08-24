// scripts/check-inventory-deduct.js
// ============================================================
// Vagthund: leverede bons der IKKE har trukket lager, mens trækket er tændt.
//
// Trin 4 i #305 — den eneste reelle forsikring mod at fejlen sker igen.
//
// Hele #305-sagen var ikke at flaget stod forkert. Det var at INGEN KUNNE SE at
// det var holdt op med at virke: en bon kunne nå LEVERET uden at trække, og
// intet sagde noget. En unit-test kan ikke fange at en indstilling står forkert
// i produktion. Det kan kun et tilbagevendende tjek der råber op — med en ejer.
//
// Scriptet kører fra cron (fx dagligt). Det:
//   • exit'er STILLE hvis trækket er slukket — den tilstand er kendt og trackes
//     af #305 selv; en daglig alarm om noget man ved, er præcis den støj folk
//     lærer at ignorere.
//   • når trækket er TÆNDT: finder leverede bons de seneste N dage uden
//     inventory_deducted — OG bons hvor trækket kun lykkedes DELVIST (#359,
//     inventory_deduct_status='partial'). De sidste har flaget sat og var
//     usynlige her indtil da, så vagthunden meldte "alt i orden" om et halvt
//     lagertræk. Begge logges, mail sendes hvis en modtager er sat, og der
//     exit'es med kode 1 så cron's egen mail (MAILTO) også fanger det.
//   • er alt trukket: exit 0, én rolig statuslinje.
//
// READ-ONLY på forretningsdata. Rører hverken bons eller Grocy.
//
// ── Konfiguration ───────────────────────────────────────────────────────────
//   INVENTORY_ALERT_EMAIL (env) ELLER settings.inventory_deduct_alert_email
//       modtager af alarm-mail. Er ingen sat, springes mailen over — så virker
//       kun log + exit-kode (cron-mail). Ingen migration nødvendig.
//   INVENTORY_CHECK_DAYS (env, default 3)
//       hvor mange dage tilbage der tjekkes. Kort med vilje: en bon leveret i
//       går der ikke trak, er en LEVENDE fejl. Historikken hører til #305's
//       Settings-panel, ikke her.
//
// ── Cron (deploy) ───────────────────────────────────────────────────────────
//   0 6 * * * cd /home/leif/bon-v2 && node --experimental-sqlite scripts/check-inventory-deduct.js >> logs/deduct-check.log 2>&1
//
//   node --experimental-sqlite scripts/check-inventory-deduct.js
// ============================================================
'use strict';
const path = require('path');
const fs   = require('fs');

// Load .env (SMTP-kredentialer m.m.) — samme mønster som booking-reminders.
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
}
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');

const { getDb } = require('../db/database');

const DAYS = Math.max(1, parseInt(process.env.INVENTORY_CHECK_DAYS, 10) || 3);

function logLine(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
const getSetting = (db, k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? '';

// Eksporteret ren funktion så testen rammer den ægte SQL frem for at replikere den.
//
// To afgrænsninger, begge tilføjet fordi kontrollen ellers råber ulv — og en alarm
// der melder det samme hver dag om noget der ikke er galt, bliver holdt op med at
// blive læst. Det er samme svigt som #305 selv, bare i den anden retning.
//
//   ØVRE DATOGRÆNSE. Uden den fanger vinduet alt fra N dage siden og FREM, mens
//   beskeden siger "de seneste N dage". En bon med leveringsdato i 2027, sat til
//   BETALT i forvejen, blev rapporteret hver eneste dag indtil datoen indtraf.
//   En fremtidig levering kan ikke have misset sit træk — den er ikke sket endnu.
//   Undtagelse: status 'failed' betyder at trækket ER forsøgt og mislykkedes, og
//   det skal frem uanset dato.
//
//   INTET AT TRÆKKE. En bon uden opskriftskoblede linjer kan aldrig trække noget.
//   Nye bons får 'empty' + flaget sat (db/helpers.js), men historiske rækker fra
//   før #359 står med flaget på 0 for evigt. Migration 141 valgte bevidst ikke at
//   bagudfylde — at gætte 'ok' bagud ville opfinde historik — så afgrænsningen
//   hører hjemme her i forespørgslen i stedet.
function findUndeducted(db, days) {
    return db.prepare(`
        SELECT b.id, b.bon_number, b.delivery_date, sd.code AS status_code,
               b.inventory_deduct_status
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE sd.code IN ('LEVERET','FAKTURERET','BETALT','AFSLUTTET')
          AND COALESCE(b.is_offer, 0) = 0
          AND COALESCE(b.inventory_deducted, 0) = 0
          AND b.delivery_date >= date('now', '-' || ? || ' days')
          AND (b.delivery_date <= date('now') OR b.inventory_deduct_status = 'failed')
          AND EXISTS (
              SELECT 1 FROM bon_lines l
              WHERE l.bon_id = b.id AND l.grocy_recipe_id IS NOT NULL
          )
        ORDER BY b.delivery_date, b.id
    `).all(days);
}

// Bons der ser ud som en manglende trækning, men ikke er det: intet på bonen kan
// trækkes. Tælles og nævnes med ét tal frem for at blive skjult helt — forsvinder
// de sporløst, kan man ikke se forskel på "ingen problemer" og "kontrollen kigger
// det forkerte sted".
function findNothingToDeduct(db, days) {
    return db.prepare(`
        SELECT b.id, b.bon_number, b.delivery_date, sd.code AS status_code
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE sd.code IN ('LEVERET','FAKTURERET','BETALT','AFSLUTTET')
          AND COALESCE(b.is_offer, 0) = 0
          AND COALESCE(b.inventory_deducted, 0) = 0
          AND b.delivery_date >= date('now', '-' || ? || ' days')
          AND b.delivery_date <= date('now')
          AND NOT EXISTS (
              SELECT 1 FROM bon_lines l
              WHERE l.bon_id = b.id AND l.grocy_recipe_id IS NOT NULL
          )
        ORDER BY b.delivery_date, b.id
    `).all(days);
}

// #359: bons hvor NOGET blev trukket og noget fejlede. De har flaget SAT (ellers
// ville en gentagelse dobbelt-trække det der lykkedes), og var derfor usynlige for
// findUndeducted ovenfor — vagthunden meldte "alt i orden" om et halvt lagertræk.
//
// Det er den samme klasse fejl som #305 selv: tilstanden fandtes, men ingen kunne se
// den. Derfor er kontrollen ikke komplet uden dette opslag.
function findPartial(db, days) {
    return db.prepare(`
        SELECT b.id, b.bon_number, b.delivery_date, sd.code AS status_code,
               b.inventory_deduct_status
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE sd.code IN ('LEVERET','FAKTURERET','BETALT','AFSLUTTET')
          AND COALESCE(b.is_offer, 0) = 0
          AND b.inventory_deduct_status = 'partial'
          AND b.delivery_date >= date('now', '-' || ? || ' days')
        ORDER BY b.delivery_date, b.id
    `).all(days);
}

async function main() {
    const db = getDb();

    // Trækket slukket → intet at overvåge. #305's Settings-panel dækker den
    // tilstand; her ville en daglig alarm bare være støj. Stille exit 0.
    if (getSetting(db, 'inventory_auto_deduct') !== '1') {
        logLine(`[deduct-check] trækket er slukket (inventory_auto_deduct != '1') — intet at overvåge.`);
        return 0;
    }

    const rows    = findUndeducted(db, DAYS);
    const partial = findPartial(db, DAYS);
    const nothing = findNothingToDeduct(db, DAYS);

    // Nævnes altid, også når alt er i orden — ellers kan man ikke se forskel på
    // "ingen problemer" og "kontrollen kigger det forkerte sted".
    if (nothing.length) {
        logLine(`[deduct-check] ${nothing.length} leveret bon(s) har intet at trække `
              + `(ingen opskriftskoblede linjer) — ikke en fejl, ikke medregnet.`);
    }

    if (rows.length === 0 && partial.length === 0) {
        logLine(`[deduct-check] OK — alle leverede bons (seneste ${DAYS} dage) har trukket lager.`);
        return 0;
    }

    // ── Drift fundet ────────────────────────────────────────────────────────
    const fmt = r => `#${r.bon_number} (${r.delivery_date}, ${r.status_code}`
                   + `${r.inventory_deduct_status ? ', ' + r.inventory_deduct_status : ''})`;

    if (rows.length) {
        logLine(`[deduct-check] ⚠ ${rows.length} leveret bon(s) de seneste ${DAYS} dage har IKKE trukket lager: `
              + rows.map(fmt).join(', '));
        logLine(`[deduct-check] Trækket er tændt, så det burde ikke ske. Mulige årsager: Grocy nede ved LEVERET `
              + `eller en consume-fejl. Tjek serverlog + scripts/dry-run-consume.js. `
              + `(Bons uden opskriftskobling er sorteret fra — de kan aldrig trække noget.)`);
    }
    if (partial.length) {
        logLine(`[deduct-check] ⚠ ${partial.length} leveret bon(s) har trukket lager DELVIST — mindst ét produkt `
              + `fejlede: ` + partial.map(fmt).join(', '));
        logLine(`[deduct-check] Lageret er for højt for de fejlede produkter. Flaget er sat (så trækket ikke kan `
              + `gentages uden at dobbelt-trække resten) — ret de enkelte produkter manuelt i Grocy. `
              + `Se changelog-posten 'grocy_consume' på bonen for hvilke der fejlede.`);
    }

    // Mail hvis en modtager er sat — ellers klarer log + exit-kode alarmen.
    const to = process.env.INVENTORY_ALERT_EMAIL || getSetting(db, 'inventory_deduct_alert_email');
    if (to) {
        try {
            const { sendMail } = require('../services/mailService');
            const line = r => `  • #${r.bon_number} — leveret ${r.delivery_date} (${r.status_code})`;
            let body = '';
            if (rows.length) {
                body += `${rows.length} leveret bon(s) de seneste ${DAYS} dage har ikke trukket lager fra Grocy:\n\n`
                      + rows.map(line).join('\n')
                      + `\n\nLagertræk er tændt, så det burde ikke ske. Undersøg:\n`
                      + `  - Var Grocy nede da bonen blev leveret?\n`
                      + `  - Mangler en linje på bonen en opskriftskobling? (kør scripts/dry-run-consume.js)\n`
                      + `  - Fejl i serverloggen omkring LEVERET-tidspunktet?\n\n`;
            }
            if (partial.length) {
                body += `${partial.length} leveret bon(s) har trukket lager DELVIST — mindst ét produkt fejlede:\n\n`
                      + partial.map(line).join('\n')
                      + `\n\nLageret er FOR HØJT for de produkter der fejlede. Trækket kan ikke bare gentages `
                      + `(det ville dobbelt-trække dem der lykkedes) — ret de enkelte produkter i Grocy.\n`
                      + `Changelog-posten 'grocy_consume' på bonen viser hvilke der fejlede.\n\n`;
            }
            body += `Denne mail sendes af scripts/check-inventory-deduct.js (cron). Se issue #305 + #359.`;

            const subject = rows.length && partial.length
                ? `⚠ Lagertræk: ${rows.length} fejlede, ${partial.length} delvise`
                : rows.length
                    ? `⚠ Lagertræk fejlede på ${rows.length} bon(s)`
                    : `⚠ Lagertræk kun delvist gennemført på ${partial.length} bon(s)`;

            await sendMail({ to, subject, text: body, smtpPrefix: 'smtp_kontakt' });
            logLine(`[deduct-check] alarm-mail sendt til ${to}.`);
        } catch (err) {
            logLine(`[deduct-check] kunne IKKE sende alarm-mail: ${err.message} (log + exit-kode gælder stadig).`);
        }
    } else {
        logLine(`[deduct-check] ingen alarm-modtager sat (INVENTORY_ALERT_EMAIL / inventory_deduct_alert_email) `
              + `— alarmen leveres via log + exit-kode 1 (cron-mail).`);
    }

    return 1;  // non-zero → cron's MAILTO fanger det uanset mail-setting
}

// Eksportér helpers til test uden at køre main().
module.exports = { findUndeducted, findPartial, findNothingToDeduct };

if (require.main === module) {
    main()
        .then(code => process.exit(code))
        .catch(err => { logLine(`[deduct-check] FATAL: ${err.message}\n${err.stack}`); process.exit(2); });
}
