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
//   ... --csv [sti]     (skriv listen til en fil man kan sortere i — 374 linjer
//                        i en terminal kan ikke gennemgås)
//   ... --limit 40      (vis flere end de 12 første pr. gruppe)
//   ... --keep-cvr      (fred også rækker der har et CVR-nummer)
// ============================================================

'use strict';

const path = require('path');
const { openDb, transaction } = require('../db/compat');

const APPLY    = process.argv.includes('--apply');
const KEEP_CVR = process.argv.includes('--keep-cvr');
const LIMIT    = (() => {
    const i = process.argv.indexOf('--limit');
    return i >= 0 ? Math.max(1, parseInt(process.argv[i + 1], 10) || 12) : 12;
})();
const CSV_PATH = (() => {
    const i = process.argv.indexOf('--csv');
    if (i < 0) return null;
    const next = process.argv[i + 1];
    return (next && !next.startsWith('--')) ? next : path.join(__dirname, '..', 'data', 'tomme-firmaer.csv');
})();
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');

const cleanup = require('../services/companyCleanup');

function main() {
    const db = openDb(DB_PATH);
    db.exec('PRAGMA foreign_keys = ON');

    const aktive = db.prepare("SELECT COUNT(*) n FROM companies WHERE is_active = 1").get().n;
    // Samme regel som CRM → Værktøjer bruger — se services/companyCleanup.js.
    const rows = cleanup.findEmptyCompanies(db, { keepCvr: KEEP_CVR });

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

    // Tre grupper, fordi de kræver hver sit blik. At dumpe 374 linjer i én bunke
    // gør listen ulæselig — og en liste man ikke kan gennemgå, bliver enten kørt
    // i blinde eller slet ikke.
    const GRUPPER = [
        { navn: 'Dubletter af et firma der handler — samme CVR, alle bons ligger på den anden række',
          note: 'kan lægges væk uden videre',
          rows: rows.filter(r => r.group === 'duplicate') },
        { navn: 'Har CVR, men ingen anden række med bons',
          note: 'ægte organisationer der aldrig blev til en ordre — skim dem',
          rows: rows.filter(r => r.group === 'dormant') },
        { navn: 'Uden CVR og uden spor',
          note: 'typisk noter og engangstekster tastet i formularens firma-felt',
          rows: rows.filter(r => r.group === 'unknown') },
    ];

    for (const g of GRUPPER) {
        if (!g.rows.length) continue;
        console.log(`\n  ${g.rows.length}  ${g.navn}`);
        console.log(`      ${g.note}`);
        for (const r of g.rows.slice(0, LIMIT)) {
            // To linjer, ikke én. "firma #2490 Akademisk Arkitektforening ⤷
            // firma #2932 Arkitektforeningen (112 bons)" blev læst som om de 112
            // hørte til den første række — den stik modsatte konklusion af den
            // pilen skulle give. Rækkens EGNE tal står nu på dens egen linje.
            //
            // Og "firma #2490", ikke bare "#2490": bon-numre ser ud som
            // "cafe-2490", så et bart tal læses som en bon.
            console.log(`      firma #${String(r.id).padEnd(5)} ${r.name.slice(0, 44).padEnd(46)} ${r.own_bons} bons · ${r.own_contacts} kontakter`);
            if (r.twin) {
                console.log(`             ↳ kunden findes stadig: firma #${r.twin.id} "${r.twin.name}" har de ${r.twin.bons} bons`);
            }
        }
        if (g.rows.length > LIMIT) console.log(`      … og ${g.rows.length - LIMIT} mere`);
    }

    if (CSV_PATH) {
        const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
        const linjer = ['firma_id;navn;cvr;gruppe;dublet_af_id;dublet_af_navn;dublet_bons;oprettet;beslutning'];
        for (const g of GRUPPER) for (const r of g.rows) {
            linjer.push([r.id, q(r.name), q(r.cvr), q(g.navn), r.twin?.id ?? '', q(r.twin?.name ?? ''),
                         r.twin?.bons ?? '', q(r.created_at), ''].join(';'));
        }
        // BOM, så æøå ikke bliver til volapyk når filen åbnes i Numbers/Excel.
        require('fs').writeFileSync(CSV_PATH, '\uFEFF' + linjer.join('\n') + '\n', 'utf8');
        console.log(`\n  📄 Hele listen: ${CSV_PATH}`);
        console.log(`      Sidste kolonne "beslutning" er tom — den er din at fylde ud.`);
    }

    if (!APPLY) {
        console.log(`\n  Ingen af dem har en bon, en kontaktperson eller en mail. Rækker med`);
        console.log(`  e-conomic-nummer, note, påmindelse, vedhæftning, event, kampagne eller`);
        console.log(`  booking-token er allerede fredet og står ikke på listen.`);
        if (!CSV_PATH) console.log(`\n  Tilføj --csv for at få hele listen som fil du kan sortere i.`);
        console.log('');
        db.close();
        return;
    }

    const backup = DB_PATH.replace(/\.db$/, '') + '.pre-empty-cleanup.db';
    require('fs').rmSync(backup, { force: true });
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    console.log(`\nBackup: ${backup}`);

    const bonsBefore = db.prepare('SELECT COUNT(*) n FROM bons').get().n;

    let result;
    transaction(db, () => {
        result = cleanup.deactivateCompanies(db, rows.map(r => r.id));
        // Værn: oprydningen må aldrig kunne røre en bon.
        const bonsAfter = db.prepare('SELECT COUNT(*) n FROM bons').get().n;
        if (bonsAfter !== bonsBefore) {
            throw new Error(`Antal bons flyttede sig (${bonsBefore}→${bonsAfter}) — ruller tilbage`);
        }
    });

    console.log(`\n✓ ${result.deactivated.length} firma-rækker deaktiveret.`);
    console.log(`   Fortryd alt:  UPDATE companies SET is_active = 1 WHERE id IN (${rows.slice(0, 5).map(r => r.id).join(',')}${rows.length > 5 ? ', …' : ''});`);
    console.log(`   eller rul databasen tilbage fra backup'en ovenfor.\n`);
    db.close();
}

main();
