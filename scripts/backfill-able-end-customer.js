#!/usr/bin/env node
// scripts/backfill-able-end-customer.js
// ==========================================
// Skriv slutkunden på de Able-bons der er ældre end feltet.
//
// `bons.end_customer_name` kom til med migration 167 (27. august 2026). Før den
// skrev kontoret hvem maden var til i fritekst — "Det er til Lundbeckfonden",
// "Det er til vores kunde: Bigum." — i interne noter eller kundeønsker. 60
// Able-bons stod uden slutkunde; 26 af dem nævner tydeligt hvem det var til.
//
// Listen nedenfor er LÆST AF ET MENNESKE, ikke udledt af et regex. Fri tekst
// kan ikke afgøres automatisk ("Att: Hans Donnerborg" er en person, "Levering
// hos able" er Able selv), og et gæt ville se ud som en måling bagefter. Bons
// uden et tydeligt spor røres ikke.
//
// Skriver KUN hvor feltet er tomt og bonnen ligger på Able — findes der allerede
// en slutkunde, vinder den. Idempotent: anden kørsel siger "0 skrives".
//
// Brug:
//   node --experimental-sqlite scripts/backfill-able-end-customer.js            # tørkørsel
//   node --experimental-sqlite scripts/backfill-able-end-customer.js --apply    # skriver (tager backup)
// ==========================================

'use strict';

const path = require('path');
const { openDb, transaction } = require('../db/compat');

const ABLE_ID   = 3570;
const ABLE_NAME = 'Able';

// bon_number → slutkunde. Kilden står som kommentar, så den kan efterprøves.
const MAPPING = {
    'cafe-2332': 'Lundbeckfonden',                                      // notes: "Levering hos Lundbeckfonden"
    'cafe-2353': 'Lundbeck',                                            // notes: "Det skal leveres til Lundbeck att. Kenneth / Lone"
    'cafe-2499': 'Lundbeckfonden',                                      // notes: "Det er til Lundbeckfonden"
    'cafe-2526': 'Lundbeckfonden',                                      // notes: "Det er til Lundbeckfonden"
    'cafe-2543': 'Lundbeckfonden',                                      // notes: "Det er til Lundbeckfonden"
    'cafe-2571': 'Lundbeckfonden',                                      // notes: "Det er til Lundbeckfonden"
    'cafe-2701': 'Lundbeckfonden',                                      // notes: "Det er til Lundbeckfonden"
    'cafe-2671': 'Worksome',                                            // notes: "Det er til: Worksome, att. Camilla"
    'cafe-2679': 'BLS Capital',                                         // notes: "Det er til BLS - Capital (…)"
    'cafe-2746': 'Scalepoint',                                          // notes: "Det er til Scalepoint. Kør gennem porten…"
    'cafe-2780': 'Tømrer- og snedkerfirmaet P. Winther Jespersen',      // notes
    'cafe-2781': 'Tømrer- og snedkerfirmaet P. Winther Jespersen',      // notes
    'cafe-2985': 'Dignity',                                             // notes: "Det er til Dignity. Skal leveres på 3 sal…"
    'cafe-3184': 'Per Aarsleff - Kontor i Lyngby',                      // wishes: "Det er til Per Aarsleff - Kontor i Lyngby og vi henter…"
    'cafe-3232': 'Per Aarsleff - Kontor i Lyngby',                      // wishes: "Det er til Per Aarsleff i Lyngby."
    'cafe-3204': 'Bigum',                                               // wishes: "Det er til vores kunde: Bigum."
    'B4193':     'TBWA Copenhagen A/S',                                 // wishes: "Firmanavn: TBWA Copenhagen A/S"
    // Anden gennemgang (15. sep.) — navnet står i teksten, min første søgning var for smal:
    'cafe-3414': 'Scalepoint Technologies Denmark A/S',                 // inv: "Bestilling til Scalepoint Technologies Denmark A/S"
    'cafe-2899': 'Scalepoint Technologies Denmark A/S',                 // notes: "Firmaet hedder Scalepoint Technologies Denmark A/S"
    'cafe-2434': 'Lundbeckfonden',                                      // notes: "Lundbeckfonden"
    'cafe-2933': 'Cisco',                                               // notes: "Delivery to the 9th floor. Company: Cisco."
    'cafe-2931': 'Cisco',                                               // wishes: "Cisco ønsker følgende: …"
    'cafe-3062': 'Per Aarsleff - Kontor i Lyngby',                      // notes: "Per Aarsleff - Kontor i Lyngby - DTU Lyngby Campus"
    'cafe-3200': 'Per Aarsleff - Kontor i Lyngby',                      // kitchen: "Skriv Per Aarsleff på denne kasse"
    'cafe-2921': 'Domutech',                                            // notes: "3.sal Domutech."
    'B4184':     'Systematic',                                          // notes: "Leveringen er til kunden Systematic."
};

const APPLY   = process.argv.includes('--apply');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');

function fail(msg) { console.error('\n✗ ' + msg); process.exit(2); }

function main() {
    const db = openDb(DB_PATH);
    const able = db.prepare('SELECT id, name FROM companies WHERE id = ?').get(ABLE_ID);
    if (!able) fail(`Firma ${ABLE_ID} findes ikke i ${DB_PATH}`);
    if (able.name.trim().toLowerCase() !== ABLE_NAME.toLowerCase()) {
        fail(`Firma ${ABLE_ID} hedder "${able.name}", ikke "${ABLE_NAME}" — er det den rigtige database?`);
    }
    console.log(`Database:   ${DB_PATH}`);
    console.log(APPLY ? '\n*** SKRIVER ***\n' : '\n(tørkørsel — intet skrives. --apply for at gennemføre)\n');

    const get = db.prepare('SELECT id, bon_number, company_id, end_customer_name FROM bons WHERE bon_number = ?');
    const plan = [], skipped = [];
    for (const [nr, name] of Object.entries(MAPPING)) {
        const b = get.get(nr);
        if (!b) { skipped.push(`${nr}: findes ikke`); continue; }
        if (b.company_id !== ABLE_ID) { skipped.push(`${nr}: ligger ikke på Able (firma ${b.company_id})`); continue; }
        if (b.end_customer_name && b.end_customer_name.trim()) {
            skipped.push(`${nr}: har allerede slutkunde "${b.end_customer_name}"`); continue;
        }
        plan.push({ ...b, name });
    }

    for (const p of plan) console.log(`  ${p.bon_number.padEnd(10)} → ${p.name}`);
    for (const s of skipped) console.log(`  (springer over) ${s}`);
    console.log(`\n${plan.length} skrives · ${skipped.length} springes over`);
    if (!plan.length || !APPLY) return;

    const backup = DB_PATH.replace(/\.db$/, '') + '.pre-able-endcustomer.db';
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    console.log(`Backup: ${backup}`);

    const upd = db.prepare('UPDATE bons SET end_customer_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND (end_customer_name IS NULL OR end_customer_name = \'\')');
    const log = db.prepare(`
        INSERT INTO changelog (entity_type, entity_id, action, field_name, old_value, new_value, notes)
        VALUES ('bon', ?, 'update', 'end_customer_name', NULL, ?, ?)`);
    transaction(db, () => {
        for (const p of plan) {
            const r = upd.run(p.name, p.id);
            if (r.changes !== 1) throw new Error(`${p.bon_number}: forventede 1 række, ramte ${r.changes} — ruller tilbage`);
            log.run(p.id, p.name, 'Slutkunde udfyldt fra fritekst (scripts/backfill-able-end-customer.js) — bonnen er ældre end feltet');
        }
    });
    console.log(`\n✓ ${plan.length} bons opdateret`);
}

main();
