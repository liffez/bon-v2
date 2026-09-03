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
//   • TÆLLER, men alarmerer ikke, de to slags bons der SKAL stå utrukne: dem
//     hvor §5-gaten siger at prep-bonnen ejer trækket (let-event salg/udgift),
//     og dem hvor der intet er at trække (alle linjer på 0 — fx en rest-prep).
//     De nævnes ved navn, så man kan se forskel på "ingen problemer" og
//     "kontrollen kigger det forkerte sted".
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
// SQLites date('now') er UTC. Mellem midnat og kl. 02 dansk sommertid peger den
// på I GÅR — og så falder dagens bons uden for vinduets øvre grænse, så
// vagthunden holder op med at se dem. Den fejl er ramt fem gange før (#133), og
// her rammer den netop dét stykke der skal fange manglende lagertræk.
// todayISO()/offsetISO() er forankret i Europe/Copenhagen.
const { todayISO, offsetISO, bonOwnsStockCostSql } = require('../db/helpers');

const DAYS = Math.max(1, parseInt(process.env.INVENTORY_CHECK_DAYS, 10) || 3);

function logLine(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
const getSetting = (db, k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? '';

// Højst så mange produktnavne i alarmen. En bon kan fejle på 30 produkter, og
// en mail der drukner i maskin-payload bliver ikke læst — samme lære som
// changelog-modalen (`_clipChangelogValue`).
const MAX_FAILED_NAMED = 6;

// Hvilke produkter fejlede i et delvist træk? Læses af `grocy_consume`-postens
// payload, som historisk har haft tre former (jf. shared/modal.js
// `_parseConsumePayload`): sentinel-strengen, et rå results-array, eller samme
// array pakket i {state, results}. Vi spejler dem alle tre.
//
// En uventet payload må ALDRIG vælte alarmen: kan den ikke læses, returneres en
// tom liste og alarmen henviser til changeloggen som før. En tavs vagthund er
// præcis den fejl den selv findes for at forhindre.
function failedProductNames(raw) {
    const txt = String(raw == null ? '' : raw).trim();
    if (!txt || txt === 'event_prep_owns_stock') return [];
    let parsed;
    try { parsed = JSON.parse(txt); } catch { return []; }
    const results = Array.isArray(parsed) ? parsed
                  : (parsed && Array.isArray(parsed.results)) ? parsed.results
                  : null;
    if (!results) return [];
    return results
        .filter(r => r && r.success === false)
        .map(r => String(r.product_name || `produkt #${r.product_id ?? '?'}`))
        // Samme produkt kan optræde to gange (parent-substitution), og et
        // dublet-navn i alarmen ser ud som to fejl.
        .filter((n, i, a) => a.indexOf(n) === i);
}

// ── Populationen, delt af alle tre opslag ───────────────────────────────────
//
// De tre funktioner nedenfor PARTITIONERER den samme mængde bons. Skrives
// betingelserne ud i hver sin forespørgsel, kan de skride fra hinanden — og så
// falder en bon ned mellem dem og bliver hverken alarmeret eller talt. Derfor
// står de her som fragmenter der bruges positivt ét sted og negativt et andet.
const KANDIDAT = `
    sd.code IN ('LEVERET','FAKTURERET','BETALT','AFSLUTTET')
    AND COALESCE(b.is_offer, 0) = 0
    AND COALESCE(b.inventory_deducted, 0) = 0`;

// "Ejer bonen sit eget lagertræk?" — §5-gaten (CLAUDE_EVENT.md §5) som SQL.
// Reglen bor ét sted, i db/helpers.js, og bruges også af driftsregnskabet.
//
// En let-event SALGSBON må ALDRIG trække HQ-lager; prep-bonnen ejer trækket.
// autoConsumeBonInventory sætter derfor flaget + 'event_prep_owns_stock' — men
// KUN når bonen passerer LEVERET. En salgsbon der er sat direkte til BETALT
// (det normale for et event: dagens salg tastes og betales) har aldrig kørt
// gaten, så flaget står på 0, og vagthunden så den som en manglende trækning.
// Ungdommens folkemøde 2. sep. 2026: B4166 trak lageret, B4167 bar betalingen —
// og vagthunden råbte op om B4167 hver morgen.
//
// Reglen GENBEREGNES, den aflæses ikke af inventory_deduct_status: det felt er
// NULL på alle event-salgsbons fra før migration 141 (samme forbehold som
// helperens egen docstring).
const EJER_TRAEKKET = bonOwnsStockCostSql('b');

// "Er der overhovedet noget at trække?" En bon uden opskriftskoblede linjer kan
// ikke trække noget — og det gælder også når linjerne findes men står på 0.
// En rest-prep-bon ("holder resten", CLAUDE.md) står netop sådan når hele dagens
// mål er forudbestilt: linjerne bliver bevidst stående på 0 så køkkenet kan se at
// bonen er håndteret. B4147/B4148 på Ungdommens folkemøde var præcis det.
//
// Nye bons får 'empty' + flaget sat (db/helpers.js), men historiske rækker fra før
// #359 står med flaget på 0 for evigt. Migration 141 valgte bevidst ikke at
// bagudfylde — at gætte 'ok' bagud ville opfinde historik — så afgrænsningen hører
// hjemme her i forespørgslen i stedet.
//
// Ekstra pakke-varer tæller MED: de kan tilføje et produkt der ikke står på nogen
// linje (applyPackingAdjustments pusher et nyt item). Pakke-overrides tæller
// derimod ikke — de kan kun ændre mængden på et item der allerede findes, aldrig
// skabe et. Er der extras men ingen linjer, alarmerer vi hellere end at tie:
// consumeRecipes returnerer i dag tomt FØR extras påføres, og dén uenighed skal
// ses, ikke skjules.
const HAR_NOGET_AT_TRAEKKE = `(
    EXISTS (SELECT 1 FROM bon_lines l
             WHERE l.bon_id = b.id AND l.grocy_recipe_id IS NOT NULL AND l.quantity > 0)
    OR EXISTS (SELECT 1 FROM prep_packing_extras e
                WHERE e.bon_id = b.id AND e.amount > 0)
)`;

// Eksporteret ren funktion så testen rammer den ægte SQL frem for at replikere den.
//
// ØVRE DATOGRÆNSE. Uden den fanger vinduet alt fra N dage siden og FREM, mens
// beskeden siger "de seneste N dage". En bon med leveringsdato i 2027, sat til
// BETALT i forvejen, blev rapporteret hver eneste dag indtil datoen indtraf.
// En fremtidig levering kan ikke have misset sit træk — den er ikke sket endnu.
// Undtagelse: status 'failed' betyder at trækket ER forsøgt og mislykkedes, og
// det skal frem uanset dato.
function findUndeducted(db, days) {
    return db.prepare(`
        SELECT b.id, b.bon_number, b.delivery_date, sd.code AS status_code,
               b.inventory_deduct_status,
               -- Passerede bonen nogensinde LEVERET? Trækket udløses KUN dér
               -- (routes/bons.js + routes/delivery.js), så en bon der er sat
               -- direkte til FAKTURERET eller BETALT har aldrig haft en chance.
               -- Uden det felt ligner "sprang forbi" og "forsøgte og fejlede"
               -- hinanden, og de kræver hver sin handling.
               EXISTS (SELECT 1 FROM changelog c
                        WHERE c.entity_type = 'bon' AND c.entity_id = b.id
                          AND c.action = 'status_change' AND c.new_value = 'LEVERET') AS saw_leveret
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE ${KANDIDAT}
          AND ${EJER_TRAEKKET}
          AND ${HAR_NOGET_AT_TRAEKKE}
          AND b.delivery_date >= ?
          AND (b.delivery_date <= ? OR b.inventory_deduct_status = 'failed')
        ORDER BY b.delivery_date, b.id
    `).all(offsetISO(-days), todayISO());
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
        WHERE ${KANDIDAT}
          AND ${EJER_TRAEKKET}
          AND NOT ${HAR_NOGET_AT_TRAEKKE}
          AND b.delivery_date >= ?
          AND b.delivery_date <= ?
        ORDER BY b.delivery_date, b.id
    `).all(offsetISO(-days), todayISO());
}

// Let-event salgs- og udgiftsbons: prep-bonnen ejer trækket, så disse SKAL stå
// utrukne. Ikke en fejl — men tælles og nævnes, af samme grund som ovenfor.
function findGatedByEventPrep(db, days) {
    return db.prepare(`
        SELECT b.id, b.bon_number, b.delivery_date, sd.code AS status_code
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE ${KANDIDAT}
          AND NOT ${EJER_TRAEKKET}
          AND b.delivery_date >= ?
          AND b.delivery_date <= ?
        ORDER BY b.delivery_date, b.id
    `).all(offsetISO(-days), todayISO());
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
               b.inventory_deduct_status,
               -- Hvilke produkter fejlede? Det er den ENESTE handling der kan
               -- tages på et delvist træk (ret dem i hånden i Grocy), så det skal
               -- stå i alarmen — ikke findes bagefter ved at åbne bonen i UI'et.
               (SELECT c.new_value FROM changelog c
                 WHERE c.entity_type = 'bon' AND c.entity_id = b.id
                   AND c.action = 'grocy_consume'
                 ORDER BY c.id DESC LIMIT 1) AS consume_payload
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE sd.code IN ('LEVERET','FAKTURERET','BETALT','AFSLUTTET')
          AND COALESCE(b.is_offer, 0) = 0
          AND b.inventory_deduct_status = 'partial'
          AND b.delivery_date >= ?
        ORDER BY b.delivery_date, b.id
    `).all(offsetISO(-days));
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
    const gated   = findGatedByEventPrep(db, DAYS);

    // Nævnes altid, også når alt er i orden — ellers kan man ikke se forskel på
    // "ingen problemer" og "kontrollen kigger det forkerte sted".
    if (nothing.length) {
        logLine(`[deduct-check] ${nothing.length} leveret bon(s) har intet at trække `
              + `(ingen opskriftslinjer med mængde) — ikke en fejl, ikke medregnet: `
              + nothing.map(r => `#${r.bon_number}`).join(', '));
    }
    if (gated.length) {
        logLine(`[deduct-check] ${gated.length} let-event bon(s) trækker med vilje ikke HQ-lager `
              + `(prep-bonnen ejer trækket, CLAUDE_EVENT.md §5) — ikke en fejl, ikke medregnet: `
              + gated.map(r => `#${r.bon_number}`).join(', '));
    }

    if (rows.length === 0 && partial.length === 0) {
        logLine(`[deduct-check] OK — alle leverede bons (seneste ${DAYS} dage) har trukket lager.`);
        return 0;
    }

    // ── Drift fundet ────────────────────────────────────────────────────────
    // Hvorfor trak den ikke? De tre svar kræver hver sin handling, så de skal
    // stå i selve alarmen — ikke findes bagefter i en database.
    const aarsag = (r) => {
        if (r.inventory_deduct_status === 'failed') return 'trækket blev FORSØGT og fejlede — kan gentages';
        if (!r.saw_leveret) return 'har ALDRIG passeret LEVERET — trækket udløses kun dér';
        return 'passerede LEVERET, men trækket satte intet spor — se serverloggen omkring det tidspunkt';
    };
    const fmt = r => `#${r.bon_number} (${r.delivery_date}, ${r.status_code}`
                   + `${r.inventory_deduct_status ? ', ' + r.inventory_deduct_status : ''}) — ${aarsag(r)}`;

    // Et delvist træk må IKKE låne årsagsteksten ovenfor. `aarsag()` læser
    // `saw_leveret`, som findPartial ikke henter, så hver eneste partial-linje
    // faldt i grenen "har ALDRIG passeret LEVERET" — om bons der står som LEVERET
    // og hvis træk beviseligt ER kørt. Alarmen pegede dermed på den forkerte
    // handling ("sæt bonen til LEVERET") i stedet for den rigtige (ret de fejlede
    // produkter i Grocy). Fundet i drift 3. sep. 2026 på #B4238/#B4239/#B4240/#B4253.
    const fmtPartial = r => {
        const navne = failedProductNames(r.consume_payload);
        const hvem = navne.length
            ? ` — fejlede: ${navne.slice(0, MAX_FAILED_NAMED).join(', ')}`
              + (navne.length > MAX_FAILED_NAMED ? ` (+${navne.length - MAX_FAILED_NAMED} mere)` : '')
            : ` — se changelog-posten 'grocy_consume' på bonen for hvilke der fejlede`;
        return `#${r.bon_number} (${r.delivery_date}, ${r.status_code})${hvem}`;
    };

    if (rows.length) {
        logLine(`[deduct-check] ⚠ ${rows.length} leveret bon(s) de seneste ${DAYS} dage har IKKE trukket lager: `
              + rows.map(fmt).join(', '));
        logLine(`[deduct-check] Trækket er tændt, så det burde ikke ske. Mulige årsager: Grocy nede ved LEVERET `
              + `eller en consume-fejl. Tjek serverlog + scripts/dry-run-consume.js. `
              + `(Bons uden opskriftskobling er sorteret fra — de kan aldrig trække noget.)`);
    }
    if (partial.length) {
        logLine(`[deduct-check] ⚠ ${partial.length} leveret bon(s) har trukket lager DELVIST — mindst ét produkt `
              + `fejlede: ` + partial.map(fmtPartial).join(', '));
        logLine(`[deduct-check] Lageret er for højt for de fejlede produkter. Flaget er sat (så trækket ikke kan `
              + `gentages uden at dobbelt-trække resten) — ret de enkelte produkter manuelt i Grocy.`);
    }

    // Mail hvis en modtager er sat — ellers klarer log + exit-kode alarmen.
    const to = process.env.INVENTORY_ALERT_EMAIL || getSetting(db, 'inventory_deduct_alert_email');
    if (to) {
        try {
            const { sendMail } = require('../services/mailService');
            const line = r => `  • ${fmt(r)}`;
            let body = '';
            if (rows.length) {
                body += `${rows.length} leveret bon(s) de seneste ${DAYS} dage har ikke trukket lager fra Grocy:\n\n`
                      + rows.map(line).join('\n')
                      + `\n\nLagertræk er tændt, så det burde ikke ske.\n\n`
                      + `  "har ALDRIG passeret LEVERET" — bonen er sat direkte til FAKTURERET/BETALT,\n`
                      + `     formentlig med force. Trækket udløses kun ved LEVERET, så det er aldrig\n`
                      + `     kørt. Lageret er FOR HØJT. Sæt bonen til LEVERET, eller træk manuelt i Grocy.\n\n`
                      + `  "trækket blev FORSØGT og fejlede" — Grocy var sandsynligvis nede. Flaget står\n`
                      + `     på 0, så trækket kan gentages: sæt bonen til LEVERET igen.\n\n`
                      + `  "satte intet spor" — undersøg serverloggen omkring LEVERET-tidspunktet.\n\n`;
            }
            if (partial.length) {
                body += `${partial.length} leveret bon(s) har trukket lager DELVIST — mindst ét produkt fejlede:\n\n`
                      + partial.map(r => `  • ${fmtPartial(r)}`).join('\n')
                      + `\n\nLageret er FOR HØJT for de produkter der fejlede. Trækket kan ikke bare gentages `
                      + `(det ville dobbelt-trække dem der lykkedes) — ret de enkelte produkter i Grocy.\n\n`;
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
module.exports = { findUndeducted, findPartial, findNothingToDeduct, findGatedByEventPrep,
                   failedProductNames };

if (require.main === module) {
    main()
        .then(code => process.exit(code))
        .catch(err => { logLine(`[deduct-check] FATAL: ${err.message}\n${err.stack}`); process.exit(2); });
}
