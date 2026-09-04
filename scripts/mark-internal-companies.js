#!/usr/bin/env node
/**
 * scripts/mark-internal-companies.js
 * ────────────────────────────────────────────────────────────
 * Markér firma-rækker som VORES EGNE (`companies.is_internal = 1`).
 *
 * Baggrund (4. sep. 2026): 16 aktive firma-rækker ER Ristet Rug — smagninger,
 * prep, salgsmøder, "Ristet Rug 21.6 kl. 18-20" — men ingen var markeret interne.
 * Uden markeringen ville koblingsværktøjet matche dem til vores EGEN e-conomic-
 * kunde på CVR, og så kan vi udstede fakturaer til os selv.
 *
 * HVAD FLAGET GØR (efterprøvet, ikke antaget):
 *   • CRM-lister, statistik, pipeline og batch-berigelse springer firmaet over.
 *   • `companyMatcher` matcher ikke web-ordrer til det.
 *   • `companyCleanup` freder det.
 *   • ⚠ `internalIdentity` gør firmaets kunders e-mailadresser til INTERNE
 *     afsendere. Mail derfra behandles som en videresendelse i stedet for at
 *     blive koblet til en kunde. Derfor blokerer scriptet hvis en adresse uden
 *     for `settings.internal_mail_domains` ville blive intern — og peger på det
 *     firma maildomænet hører til, så blokeringen kan handles på i stedet for
 *     bare at være en oplysning.
 *
 * HVAD FLAGET IKKE GØR: det rører ikke `bons.is_internal`, og rapporter,
 * dashboard og driftsregnskab læser netop bon-flaget. Omsætningstal er derfor
 * uændrede. Skal bonnerne også markeres, er det en SELVSTÆNDIG beslutning med
 * synlige konsekvenser for regnskabet — scriptet rapporterer dem, men rører dem ikke.
 *
 * CVR-numrene skal gives eksplicit. `settings.company_cvr` er 41497487, mens
 * rækkerne i drift bærer 27606644 og 40140255 — huset har haft flere numre, så
 * et gæt ud fra settings ville ramme forbi.
 *
 * Kør:
 *   node --experimental-sqlite scripts/mark-internal-companies.js --cvr 27606644 --cvr 40140255
 *   … og igen med --apply når listen ser rigtig ud.
 * ────────────────────────────────────────────────────────────
 */

const path = require('node:path');
const fs = require('node:fs');
const { openDb } = require('../db/compat');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const APPLY = has('--apply');
const ACCEPT_EXTERNAL = has('--accept-external-mail');
const CVRS = argv.reduce((acc, a, i) => {
    if (a === '--cvr' && argv[i + 1]) acc.push(String(argv[i + 1]).replace(/\D/g, ''));
    return acc;
}, []);

const DB_PATH = process.env.DB_PATH || './data/bon.db';

function main() {
    if (!CVRS.length) {
        console.error('Brug: --cvr <8 cifre> (kan gentages) [--apply] [--accept-external-mail]');
        console.error('Vi gætter aldrig på hvilke firmaer der er vores egne.');
        process.exit(2);
    }

    const db = openDb(DB_PATH);
    const q = CVRS.map(() => '?').join(',');

    const rows = db.prepare(`
        SELECT co.id, co.name, co.cvr, COALESCE(co.is_internal, 0) AS is_internal,
               (SELECT COUNT(*) FROM bons b WHERE b.company_id = co.id) AS bons,
               (SELECT COUNT(*) FROM bons b
                 WHERE b.company_id = co.id AND COALESCE(b.is_internal,0) = 0
                   AND b.payment_type = 'invoice') AS faktura_bons,
               (SELECT ROUND(COALESCE(SUM(b.total_price),0)) FROM bons b
                 WHERE b.company_id = co.id AND COALESCE(b.is_internal,0) = 0
                   AND b.payment_type = 'invoice') AS faktura_kr
        FROM companies co
        WHERE co.is_active = 1 AND REPLACE(COALESCE(co.cvr,''),' ','') IN (${q})
        ORDER BY bons DESC, co.id
    `).all(...CVRS);

    if (!rows.length) { console.log('Ingen aktive firmaer med de CVR-numre. Intet at gøre.'); return; }

    console.log(`\n${APPLY ? 'MARKERER' : 'DRY-RUN — markerer'} ${rows.length} firma-rækker som interne\n`);
    let already = 0;
    for (const r of rows) {
        const mark = r.is_internal ? '  (allerede intern)' : '';
        if (r.is_internal) already++;
        console.log(`  #${String(r.id).padEnd(5)} ${String(r.name).slice(0, 36).padEnd(38)} CVR ${r.cvr}  ${String(r.bons).padStart(3)} bons${mark}`);
    }

    // ── Mail-konsekvensen: hvilke adresser ville blive interne? ──
    const domains = (db.prepare(`SELECT value FROM settings WHERE key = 'internal_mail_domains'`).get()?.value || '')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const isInternalAddr = (email) => {
        const e = String(email || '').toLowerCase().trim();
        if (!e.includes('@')) return true;                 // ikke en adresse — harmløs i sættet
        return domains.some(d => (d.includes('@') ? e === d : e.endsWith('@' + d)));
    };

    // Hvilket firma hører maildomænet til? En adresse under vores eget firma er
    // som regel en fejlplacering fra v1-importen, og så er svaret "hvor hører den
    // hjemme" den handling der skal tages. Vi leder efter domænet blandt de
    // kontaktpunkter der allerede peger på et rigtigt firma.
    //
    // Gratis-domæner udelades: gmail/hotmail siger intet om arbejdsgiver, og et
    // forslag derfra ville pege på et tilfældigt firma hvor nogen har brugt sin
    // private adresse.
    const FREE_MAIL = new Set([
        'gmail.com', 'hotmail.com', 'hotmail.dk', 'outlook.com', 'outlook.dk',
        'live.dk', 'yahoo.com', 'yahoo.dk', 'me.com', 'icloud.com', 'mail.dk',
    ]);
    const domainOf = (e) => String(e || '').toLowerCase().split('@')[1] || '';

    const suggestCompany = db.prepare(`
        SELECT co.id, co.name, COUNT(*) AS n
          FROM contact_points cp
          JOIN customers c  ON c.id  = cp.entity_id AND cp.entity_type = 'customer'
          JOIN companies co ON co.id = c.company_id
         WHERE cp.kind = 'email' AND cp.is_active = 1
           AND LOWER(cp.value) LIKE ?
           AND co.is_active = 1
           AND REPLACE(COALESCE(co.cvr,''),' ','') NOT IN (${q})
         GROUP BY co.id
         ORDER BY n DESC, co.id
         LIMIT 2
    `);

    const emails = db.prepare(`
        SELECT co.id AS company_id, co.name AS company_name, c.id AS customer_id,
               TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS navn,
               LOWER(TRIM(c.email)) AS email
        FROM companies co JOIN customers c ON c.company_id = co.id
        WHERE co.is_active = 1 AND c.is_active = 1
          AND c.email IS NOT NULL AND TRIM(c.email) <> ''
          AND REPLACE(COALESCE(co.cvr,''),' ','') IN (${q})
    `).all(...CVRS);
    const external = emails.filter(e => !isInternalAddr(e.email));

    if (external.length) {
        console.log(`\n⚠  ${external.length} EKSTERNE adresser ville blive behandlet som interne afsendere:\n`);
        for (const e of external) {
            console.log(`     ${e.email.padEnd(26)} — ${e.navn || '‹uden navn›'} (kunde #${e.customer_id}, under #${e.company_id} ${e.company_name})`);
            const dom = domainOf(e.email);
            if (!dom || FREE_MAIL.has(dom)) continue;
            const hits = suggestCompany.all('%@' + dom, ...CVRS);
            if (hits.length === 1) {
                console.log(`     ${' '.repeat(26)}   ↳ hører formentlig til #${hits[0].id} ${hits[0].name}`);
            } else if (hits.length > 1) {
                console.log(`     ${' '.repeat(26)}   ↳ flere kandidater på @${dom}: ${hits.map(h => `#${h.id} ${h.name}`).join(' · ')}`);
            }
        }
        console.log(`\n   Interne domæner i dag: ${domains.join(', ') || '‹ingen›'}`);
        console.log('   Mail fra dem ville herefter lande i den ufordelte indbakke i stedet for');
        console.log('   at blive koblet til en kunde. Flyt dem til deres eget firma med blyanten');
        console.log('   på kundekortet, eller kør med --accept-external-mail.');
        if (!ACCEPT_EXTERNAL) {
            console.log('\n❌ Afbrudt. Intet ændret.');
            process.exit(1);
        }
        console.log('   → --accept-external-mail givet: fortsætter alligevel.');
    }

    // ── Det scriptet bevidst IKKE gør ──
    const bonSum = rows.reduce((s, r) => s + (r.faktura_bons || 0), 0);
    const krSum = rows.reduce((s, r) => s + (r.faktura_kr || 0), 0);
    if (bonSum) {
        console.log(`\nℹ  ${bonSum} faktura-bons på rækkerne er IKKE markeret interne på selve bonen`);
        console.log(`   (${krSum.toLocaleString('da-DK')} kr, som i dag tæller med i omsætningen).`);
        console.log('   Rapporter og driftsregnskab læser bon-flaget, ikke firmaets — så de tal er');
        console.log('   uændrede af denne kørsel. At markere bonnerne er en selvstændig beslutning.');
    }

    const toChange = rows.filter(r => !r.is_internal);
    if (!toChange.length) { console.log('\nAlle er allerede markeret interne. Intet at gøre.'); return; }

    if (!APPLY) {
        console.log(`\n${toChange.length} rækker ville blive ændret (${already} er det allerede). Kør igen med --apply.`);
        return;
    }

    // Backup før skrivning — samme mønster som de øvrige oprydnings-scripts.
    const backup = DB_PATH.replace(/\.db$/, '') + `.before-mark-internal.db`;
    try { fs.rmSync(backup, { force: true }); } catch { /* findes ikke */ }
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    console.log(`\nBackup: ${path.resolve(backup)}`);

    db.exec('BEGIN IMMEDIATE');
    try {
        const upd = db.prepare('UPDATE companies SET is_internal = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
        const log = db.prepare(`
            INSERT INTO changelog (entity_type, entity_id, action, field_name, old_value, new_value, user_id, notes)
            VALUES ('company', ?, 'update', 'is_internal', '0', '1', NULL, ?)`);
        for (const r of toChange) {
            upd.run(r.id);
            log.run(r.id, `Markeret som vores eget firma (CVR ${r.cvr}) — holdes ude af CRM og af e-conomic-koblingen`);
        }
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        console.error('\n❌ Rullet tilbage:', err.message);
        process.exit(1);
    }

    console.log(`\n✓ ${toChange.length} firmaer markeret interne.`);
    console.log('  Mail-routingens cache er 60 sekunder — den retter sig selv.');
}

main();
