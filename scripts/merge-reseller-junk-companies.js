#!/usr/bin/env node
// scripts/merge-reseller-junk-companies.js
// ============================================================
// Ryd op i de firma-rækker forhandler-bestillinger nåede at oprette, FØR
// migration 167 lagde bonnen på forhandleren.
//
// Baggrund: bestillingsformularens Firma-felt er fri tekst, og webhooken
// matchede det på eksakt navn. Skrev Able "Systematic / able", opstod et firma
// af det navn — uden CVR, uden e-conomic-nummer og uden kontaktpersoner. Bonnen
// landede dér og kunne derefter hverken faktureres eller tælles med i Ables
// omsætning.
//
// ⚠️ Det er IKKE en almindelig firma-sammenlægning. Rækkens NAVN er den eneste
// oplysning vi har om hvem slutkunden var. En blind merge ville kaste den væk.
// Scriptet skriver derfor navnet over i `bons.end_customer_name` FØR bonnen
// flyttes — informationen overlever, den flytter bare hen hvor den hører til.
//
// Rækkerne udpeges ÉN AD GANGEN i tabellen nedenfor. De gættes ikke ud fra
// navnet: en søgning på "able" fanger også `A Table Story ApS`, som intet har
// med Able at gøre. Hvert punkt kontrolleres mod databasen inden der skrives,
// og afviger noget, stopper scriptet frem for at gøre sit bedste.
//
//   node --experimental-sqlite scripts/merge-reseller-junk-companies.js
//   node --experimental-sqlite scripts/merge-reseller-junk-companies.js --apply
// ============================================================

'use strict';

const path = require('path');
const { openDb, transaction } = require('../db/compat');

// ── Hvem er forhandleren, og hvilke rækker hører til? ───────────────────────
//
// `expect_name` er en spærre: matcher navnet ikke præcist det vi så da planen
// blev lagt, er rækken en anden end den vi mente, og scriptet stopper.
//
//   kind: 'duplicate'     rækken ER forhandleren under et andet navn (samme
//                         CVR). Bonnen flyttes, ingen slutkunde skrives.
//   kind: 'end_customer'  rækken er en SLUTKUNDE tastet ind som firma.
//                         `end_customer` skrives på bonnen, hvorefter den flyttes.
const RESELLER_ID = 3570;               // Able
const RESELLER_NAME = 'Able';

const PLAN = [
    { id: 3551, expect_name: 'able ApS',           kind: 'duplicate' },
    { id: 3951, expect_name: 'Cisco / able',       kind: 'end_customer', end_customer: 'Cisco' },
    { id: 4176, expect_name: 'Systematic / able',  kind: 'end_customer', end_customer: 'Systematic' },
    { id: 4182, expect_name: 'Systematic  (Able)', kind: 'end_customer', end_customer: 'Systematic' },
];

// Rækker vi bevidst IKKE rører — skrevet ned, så næste person ikke skal regne
// den ud igen (og ikke kommer til at feje dem med i en bredere søgning):
//
//   3397  'able'                                 = A Table Story ApS (CVR 44129485).
//                                                  Et helt andet firma. Navnet er et
//                                                  tilfældigt delstrengs-match.
//   3652  'able /Per Aarsleff - Kontor i Lyngby' = Per Aarsleff A/S (CVR 37542784)
//   3654  'able/Per Aarsleff - Kontor i Lyngby'  = do. — dublet af 3652
//   3703  'Brunata / able'                       = BRUNATA A/S (CVR 22166514)
//
// De tre sidste har 0 bons, men bærer ægte CVR, juridisk navn, branche og
// kontaktpunkter fra CVR-berigelse. De skal omdøbes til deres rigtige navne
// (og 3652/3654 lægges sammen), ikke slettes — det er en beslutning for et
// menneske, ikke for et script.

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');

function main() {
    const db = openDb(DB_PATH);
    db.exec('PRAGMA foreign_keys = ON');

    const reseller = db.prepare('SELECT id, name, cvr FROM companies WHERE id = ?').get(RESELLER_ID);
    if (!reseller) fail(`Forhandleren (id ${RESELLER_ID}) findes ikke i ${DB_PATH}`);
    if (reseller.name !== RESELLER_NAME) {
        fail(`Forhandler ${RESELLER_ID} hedder "${reseller.name}", ikke "${RESELLER_NAME}" — er det den rigtige database?`);
    }

    console.log(`\nForhandler: ${reseller.name} (#${reseller.id})`);
    console.log(`Database:   ${DB_PATH}`);
    console.log(APPLY ? '\n*** SKRIVER ***\n' : '\n(tørkørsel — intet skrives. --apply for at gennemføre)\n');

    const work = [];
    for (const p of PLAN) {
        const co = db.prepare('SELECT id, name, cvr, economic_customer_id, is_active FROM companies WHERE id = ?').get(p.id);
        if (!co) { console.log(`  ⤳ #${p.id} findes ikke længere — sprunget over`); continue; }
        if (co.name !== p.expect_name) {
            fail(`#${p.id} hedder nu "${co.name}", men planen er lagt for "${p.expect_name}".\n` +
                 `   Rækken er ændret siden planen blev lagt. Gennemgå den i hånden.`);
        }
        if (p.kind === 'duplicate' && co.cvr && reseller.cvr && co.cvr !== reseller.cvr) {
            fail(`#${p.id} "${co.name}" har CVR ${co.cvr}, forhandleren har ${reseller.cvr}.\n` +
                 `   Det er ikke samme firma — den må ikke lægges sammen.`);
        }

        const bons = db.prepare(`
            SELECT b.id, b.bon_number, b.delivery_date, b.end_customer_name, sd.code AS status
              FROM bons b JOIN status_definitions sd ON sd.id = b.status_id
             WHERE b.company_id = ?
        `).all(p.id);
        const kunder = db.prepare('SELECT id, first_name, last_name FROM customers WHERE company_id = ?').all(p.id);

        if (!co.is_active && !bons.length && !kunder.length) {
            console.log(`  ⤳ #${p.id} "${co.name}" er allerede ryddet — sprunget over`);
            continue;
        }

        work.push({ ...p, co, bons, kunder });

        console.log(`  #${p.id} "${co.name}"  [${p.kind === 'duplicate' ? 'dublet af forhandleren' : 'slutkunde: ' + p.end_customer}]`);
        for (const b of bons) {
            const slut = p.kind === 'end_customer'
                ? (b.end_customer_name ? `slutkunde står allerede: "${b.end_customer_name}" — bevares` : `slutkunde sættes til "${p.end_customer}"`)
                : 'ingen slutkunde (dublet)';
            console.log(`      ${b.bon_number}  ${b.delivery_date}  ${b.status.padEnd(11)} → flyttes til ${reseller.name} · ${slut}`);
        }
        if (!bons.length) console.log('      (ingen bons)');
        for (const k of kunder) console.log(`      kontakt ${k.first_name} ${k.last_name || ''} → flyttes til ${reseller.name}`);
        console.log(`      rækken deaktiveres (slettes ikke — historikken skal kunne læses)`);
    }

    const totalBons = work.reduce((n, w) => n + w.bons.length, 0);
    console.log(`\n${work.length} række(r) · ${totalBons} bon(s) flyttes\n`);

    if (!APPLY) { db.close(); return; }
    if (!totalBons && !work.length) { console.log('Intet at gøre.'); db.close(); return; }

    // Backup før skrivning — VACUUM INTO er WAL-sikker.
    const backup = DB_PATH.replace(/\.db$/, '') + `.pre-reseller-merge.db`;
    require('fs').rmSync(backup, { force: true });
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    console.log(`Backup: ${backup}`);

    const bonsBefore = db.prepare('SELECT COUNT(*) n FROM bons').get().n;
    const sumBefore  = db.prepare('SELECT ROUND(COALESCE(SUM(total_price),0),2) s FROM bons').get().s;

    transaction(db, () => {
        for (const w of work) {
            for (const b of w.bons) {
                // Slutkunden FØRST — flyttes bonnen først og fejler dette, står
                // vi med en bon på forhandleren og ingen anelse om hvem den var til.
                if (w.kind === 'end_customer' && !b.end_customer_name) {
                    db.prepare('UPDATE bons SET end_customer_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                      .run(w.end_customer, b.id);
                    logChange(db, b.id, 'end_customer_name', null, w.end_customer,
                        `udledt af firma-rækken "${w.co.name}", som bonnen lå på`);
                }
                db.prepare('UPDATE bons SET company_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                  .run(RESELLER_ID, b.id);
                logChange(db, b.id, 'company_id', w.co.id, RESELLER_ID,
                    `flyttet fra "${w.co.name}" til forhandleren ${reseller.name}`);
            }
            for (const k of w.kunder) {
                db.prepare('UPDATE customers SET company_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                  .run(RESELLER_ID, k.id);
            }
            db.prepare('UPDATE companies SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(w.co.id);
            db.prepare(`
                INSERT INTO changelog (entity_type, entity_id, action, field_name, old_value, new_value, notes)
                VALUES ('company', ?, 'update', 'is_active', 1, 0, ?)
            `).run(w.co.id, `deaktiveret — indholdet flyttet til ${reseller.name} (#${RESELLER_ID})`);
        }

        const bonsAfter = db.prepare('SELECT COUNT(*) n FROM bons').get().n;
        const sumAfter  = db.prepare('SELECT ROUND(COALESCE(SUM(total_price),0),2) s FROM bons').get().s;
        if (bonsAfter !== bonsBefore || sumAfter !== sumBefore) {
            throw new Error(`Antal bons eller omsætning flyttede sig (${bonsBefore}→${bonsAfter}, ${sumBefore}→${sumAfter}) — ruller tilbage`);
        }
    });

    console.log(`\n✓ Gennemført. ${totalBons} bon(s) ligger nu på ${reseller.name}.`);
    db.close();
}

function logChange(db, bonId, field, oldVal, newVal, notes) {
    db.prepare(`
        INSERT INTO changelog (entity_type, entity_id, action, field_name, old_value, new_value, notes)
        VALUES ('bon', ?, 'update', ?, ?, ?, ?)
    `).run(bonId, field, oldVal == null ? null : String(oldVal), newVal == null ? null : String(newVal), notes);
}

function fail(msg) { console.error('\n✗ ' + msg + '\n'); process.exit(1); }

main();
