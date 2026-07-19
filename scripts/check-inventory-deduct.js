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
//     inventory_deducted, logger dem, sender mail hvis en modtager er sat, og
//     exit'er med kode 1 så cron's egen mail (MAILTO) også fanger det.
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
// To tilstande skal fanges (#359):
//   inventory_deducted = 0   intet blev trukket — sikkert at prøve igen
//   ..._status = 'partial'   nogle produkter fejlede; flaget er sat for at
//                            undgå dobbelt-træk, så uden dette led ville
//                            bonen se ud som fuldt trukket
// Tidligere kiggede vagthunden kun på flaget, og fordi et fejlet træk SATTE
// flaget, var den blind over for præcis den fejl den blev bygget til at fange.
function findUndeducted(db, days) {
    return db.prepare(`
        SELECT b.id, b.bon_number, b.delivery_date, sd.code AS status_code,
               COALESCE(b.inventory_deduct_status, '') AS deduct_status
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE sd.code IN ('LEVERET','FAKTURERET','BETALT','AFSLUTTET')
          AND COALESCE(b.is_offer, 0) = 0
          AND (COALESCE(b.inventory_deducted, 0) = 0
               OR b.inventory_deduct_status = 'partial')
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

    const rows = findUndeducted(db, DAYS);
    if (rows.length === 0) {
        logLine(`[deduct-check] OK — alle leverede bons (seneste ${DAYS} dage) har trukket lager.`);
        return 0;
    }

    // ── Drift fundet ────────────────────────────────────────────────────────
    const label = (r) => r.deduct_status === 'partial' ? 'DELVIST trukket'
                       : r.deduct_status === 'failed'  ? 'træk fejlede'
                       : 'ikke trukket';
    const list = rows.map(r => `#${r.bon_number} (${r.delivery_date}, ${r.status_code}, ${label(r)})`).join(', ');
    logLine(`[deduct-check] ⚠ ${rows.length} leveret bon(s) de seneste ${DAYS} dage har IKKE trukket lager korrekt: ${list}`);
    logLine(`[deduct-check] Trækket er tændt, så det burde ikke ske. Mulige årsager: Grocy nede ved LEVERET, `
          + `en bon uden opskriftskobling, eller en consume-fejl. Tjek serverlog + scripts/dry-run-consume.js.`);

    // Mail hvis en modtager er sat — ellers klarer log + exit-kode alarmen.
    const to = process.env.INVENTORY_ALERT_EMAIL || getSetting(db, 'inventory_deduct_alert_email');
    if (to) {
        try {
            const { sendMail } = require('../services/mailService');
            const body =
                `${rows.length} leveret bon(s) de seneste ${DAYS} dage har ikke trukket lager fra Grocy:\n\n`
              + rows.map(r => `  • #${r.bon_number} — leveret ${r.delivery_date} (${r.status_code})`).join('\n')
              + `\n\nLagertræk er tændt, så det burde ikke ske. Undersøg:\n`
              + `  - Var Grocy nede da bonen blev leveret?\n`
              + `  - Mangler en linje på bonen en opskriftskobling? (kør scripts/dry-run-consume.js)\n`
              + `  - Fejl i serverloggen omkring LEVERET-tidspunktet?\n\n`
              + `Denne mail sendes af scripts/check-inventory-deduct.js (cron). Se issue #305.`;
            await sendMail({
                to,
                subject: `⚠ Lagertræk fejlede på ${rows.length} bon(s)`,
                bodyText: body,
                smtpPrefix: 'smtp_kontakt',
            });
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

// Eksportér helper til test uden at køre main().
module.exports = { findUndeducted };

if (require.main === module) {
    main()
        .then(code => process.exit(code))
        .catch(err => { logLine(`[deduct-check] FATAL: ${err.message}\n${err.stack}`); process.exit(2); });
}
