#!/usr/bin/env node
// scripts/audit-empty-companies.js
// ============================================================
// Find de firma-rækker der ikke bærer noget, og læg dem væk.
//
// Bestillingsformularens Firma-felt er fri tekst, og webhooken har indtil
// migration 167 oprettet et firma for hver skrivemåde. Sammen med v1-importen,
// der tog fire varianter af samme firma med over, har det efterladt et
// kartotek hvor knap en tredjedel af rækkerne er tomme.
//
// REGLEN (fra drift, 28. august 2026): en række beholdes hvis der er en bon,
// en kontaktperson eller en mail på den. Er der intet af delene, er den et
// artefakt.
//
// Til reglen er lagt fire værn, som ALLE fredede rækker skal passere. De er
// ikke pynt — hver af dem dækker en måde en "tom" række kan vise sig at bære
// noget alligevel:
//
//   • e-conomic-kundenummer  rækken er koblet til regnskabet
//   • is_internal            Ristet Rug selv
//   • påmindelse (flag)      nogen har skrevet en note der skal hejses
//   • fremmednøgler          et event, en kampagne eller et booking-token peger
//                            på rækken (IKKE rfm_scores — se noten ved SQL'en)
//   • note, vedhæftning,     nogen har skrevet eller lagt noget på rækken.
//     custom-felt            Vedhæftninger og custom-felter er tomme i dag, men
//                            referencerne findes — værnet skal være der FØR
//                            nogen begynder at bruge dem, ikke bagefter.
//
// Rækker DEAKTIVERES (`is_active = 0`) — de slettes aldrig. En bon, en faktura
// eller en changelog-linje kan pege på en række år efter, og historikken skal
// kunne læses. Deaktivering skjuler dem i lister og søgning; den kan rulles
// tilbage med ét UPDATE.
//
//   node --experimental-sqlite scripts/audit-empty-companies.js
//   node --experimental-sqlite scripts/audit-empty-companies.js --apply
//   ... --limit 40      (vis flere end de 25 første i rapporten)
//   ... --keep-cvr      (fred også rækker der har et CVR-nummer)
// ============================================================

'use strict';

const path = require('path');
const { openDb, transaction } = require('../db/compat');

const APPLY    = process.argv.includes('--apply');
const KEEP_CVR = process.argv.includes('--keep-cvr');
const LIMIT    = (() => {
    const i = process.argv.indexOf('--limit');
    return i >= 0 ? Math.max(1, parseInt(process.argv[i + 1], 10) || 25) : 25;
})();
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');

const CANDIDATE_SQL = `
    SELECT c.id, c.name, COALESCE(c.cvr,'') cvr, COALESCE(c.created_at,'') created_at
      FROM companies c
     WHERE c.is_active = 1
       AND COALESCE(c.is_internal, 0) = 0
       AND COALESCE(c.economic_customer_id, '') = ''
       ${KEEP_CVR ? "AND COALESCE(c.cvr,'') = ''" : ''}
       -- Reglen: hverken bon, kontaktperson eller mail
       AND NOT EXISTS (SELECT 1 FROM bons b       WHERE b.company_id  = c.id)
       AND NOT EXISTS (SELECT 1 FROM customers cu WHERE cu.company_id = c.id AND cu.is_active = 1)
       AND NOT EXISTS (
             SELECT 1 FROM mail_threads mt
               JOIN customers cu2 ON cu2.id = mt.customer_id
              WHERE cu2.company_id = c.id)
       -- Værn: noget andet peger på rækken
       AND NOT EXISTS (SELECT 1 FROM entity_flags ef
                        WHERE ef.entity_type = 'company' AND ef.entity_id = c.id
                          AND ef.dismissed_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM events e          WHERE e.company_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM campaign_members m WHERE m.company_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM booking_tokens t   WHERE t.company_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM attachments a
                        WHERE a.entity_type = 'company' AND a.entity_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM crm_custom_values v
                        WHERE v.entity_type = 'company' AND v.entity_id = c.id)
       AND TRIM(COALESCE(c.notes, '')) = ''
       -- rfm_scores er BEVIDST ikke et værn: tabellen er beregnet og har en
       -- række for stort set hvert firma (1.346 af 1.452 i drift). Bruges den
       -- som bevis på en relation, freder den alt, og reglen bliver tom. Målt:
       -- 377 kandidater → 0.
     ORDER BY c.id
`;

function main() {
    const db = openDb(DB_PATH);
    db.exec('PRAGMA foreign_keys = ON');

    const aktive = db.prepare("SELECT COUNT(*) n FROM companies WHERE is_active = 1").get().n;
    const rows = db.prepare(CANDIDATE_SQL).all();

    console.log(`\nDatabase: ${DB_PATH}`);
    console.log(`Aktive firmaer: ${aktive}`);
    console.log(`Uden bon, kontakt eller mail: ${rows.length}` + (KEEP_CVR ? '  (rækker med CVR er fredet)' : ''));
    console.log(APPLY ? '\n*** DEAKTIVERER ***\n' : '\n(tørkørsel — intet skrives. --apply for at gennemføre)\n');

    // Hvad blev fredet, og af hvad? Et værktøj der kun viser hvad der ryger, er
    // svært at stole på — man kan ikke se om reglen greb for bredt.
    const spared = db.prepare(`
        SELECT
          SUM(CASE WHEN COALESCE(c.economic_customer_id,'') <> '' THEN 1 ELSE 0 END) econ,
          SUM(CASE WHEN TRIM(COALESCE(c.notes,'')) <> '' THEN 1 ELSE 0 END)          note,
          SUM(CASE WHEN COALESCE(c.is_internal,0) = 1 THEN 1 ELSE 0 END)             intern
        FROM companies c
        WHERE c.is_active = 1
          AND NOT EXISTS (SELECT 1 FROM bons b       WHERE b.company_id  = c.id)
          AND NOT EXISTS (SELECT 1 FROM customers cu WHERE cu.company_id = c.id AND cu.is_active = 1)
          AND NOT EXISTS (SELECT 1 FROM mail_threads mt
                            JOIN customers cu2 ON cu2.id = mt.customer_id
                           WHERE cu2.company_id = c.id)
    `).get();
    const fredet = [];
    if (spared.econ)   fredet.push(`${spared.econ} med e-conomic-nummer`);
    if (spared.note)   fredet.push(`${spared.note} med en note`);
    if (spared.intern) fredet.push(`${spared.intern} interne`);
    if (fredet.length) console.log(`Fredet trods tom række: ${fredet.join(' · ')}`);

    if (!rows.length) { console.log('\nIntet at rydde op.'); db.close(); return; }

    const medCvr = rows.filter(r => r.cvr).length;
    console.log(`  heraf med CVR: ${medCvr}   uden CVR: ${rows.length - medCvr}\n`);

    for (const r of rows.slice(0, LIMIT)) {
        console.log(`  #${String(r.id).padEnd(5)} ${r.name.slice(0, 58).padEnd(60)} ${r.cvr ? 'CVR ' + r.cvr : ''}`);
    }
    if (rows.length > LIMIT) console.log(`  … og ${rows.length - LIMIT} mere (--limit ${rows.length} for at se alle)`);

    if (!APPLY) {
        console.log(`\nIngen af dem har en bon, en kontaktperson eller en mail.`);
        console.log(`Rækker med e-conomic-nummer, påmindelse, event, tilbud, kampagne eller`);
        console.log(`booking-token er allerede fredet og står ikke på listen.\n`);
        db.close();
        return;
    }

    const backup = DB_PATH.replace(/\.db$/, '') + '.pre-empty-cleanup.db';
    require('fs').rmSync(backup, { force: true });
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    console.log(`\nBackup: ${backup}`);

    const bonsBefore = db.prepare('SELECT COUNT(*) n FROM bons').get().n;

    transaction(db, () => {
        const upd = db.prepare('UPDATE companies SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
        const log = db.prepare(`
            INSERT INTO changelog (entity_type, entity_id, action, field_name, old_value, new_value, notes)
            VALUES ('company', ?, 'update', 'is_active', 1, 0, ?)
        `);
        for (const r of rows) {
            upd.run(r.id);
            log.run(r.id, 'deaktiveret — ingen bon, kontaktperson eller mail på rækken');
        }
        // Værn: oprydningen må aldrig kunne røre en bon.
        const bonsAfter = db.prepare('SELECT COUNT(*) n FROM bons').get().n;
        if (bonsAfter !== bonsBefore) {
            throw new Error(`Antal bons flyttede sig (${bonsBefore}→${bonsAfter}) — ruller tilbage`);
        }
    });

    console.log(`\n✓ ${rows.length} firma-rækker deaktiveret.`);
    console.log(`   Fortryd alt:  UPDATE companies SET is_active = 1 WHERE id IN (${rows.slice(0, 5).map(r => r.id).join(',')}${rows.length > 5 ? ', …' : ''});`);
    console.log(`   eller rul databasen tilbage fra backup'en ovenfor.\n`);
    db.close();
}

main();
