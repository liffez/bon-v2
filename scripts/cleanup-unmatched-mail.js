#!/usr/bin/env node --experimental-sqlite
/**
 * scripts/cleanup-unmatched-mail.js
 *
 * Marker auto-afsendere (HubSpot, Jotform, bounces) i `mail_unmatched` som
 * `status='ignored'`. Disse er gamle notifikationer fra systemer der ikke
 * længere er i brug — sikre at rydde uden risiko.
 *
 * Brug:
 *   node --experimental-sqlite scripts/cleanup-unmatched-mail.js          # dry-run (default)
 *   node --experimental-sqlite scripts/cleanup-unmatched-mail.js --apply  # udfør faktisk
 *
 * Efter kørsel: tjek CRM Indbakke — burde gå fra 1412 til ~78 mails.
 */

const { getDb } = require('../db/database');

const APPLY = process.argv.includes('--apply');

// Auto-afsender-mønstre — match AUTO_IGNORE_FROM_PATTERNS i mailService.js
// og migration 066 (rensning). Bounces er IKKE her — de er forretnings-
// kritiske signaler om kunder med forkert email (se migration 067).
const FROM_PATTERNS = [
    // HubSpot — gamle form-notifikationer (incl. alle subdomæner)
    { pattern: '%hubspot.com',            label: 'HubSpot (alle subdomæner)' },
    // Jotform — gamle form-submissions
    { pattern: '%@jotform.com',           label: 'Jotform' },
];

const SUBJECT_PATTERNS = [
    { pattern: 'Autosvar:%',              label: 'Autosvar (DK)' },
    { pattern: 'Out of Office:%',         label: 'Out of Office (EN)' },
    { pattern: 'Automatic reply:%',       label: 'Automatic reply (EN)' },
];

function main() {
    const db = getDb();

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(' OPRYDNING AF mail_unmatched');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(APPLY ? ' MODE: APPLY (ændringer GEMMES)' : ' MODE: DRY-RUN (ingen ændringer)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    const beforeOpen = db.prepare("SELECT COUNT(*) AS c FROM mail_unmatched WHERE status='open'").get().c;
    console.log('Åbne mails før oprydning: ' + beforeOpen);
    console.log('');

    let totalToIgnore = 0;
    const matchedIds = new Set();

    console.log(' From-email mønstre:');
    for (const p of FROM_PATTERNS) {
        const rows = db.prepare(
            "SELECT id FROM mail_unmatched WHERE status='open' AND from_email LIKE ?"
        ).all(p.pattern);
        const newIds = rows.filter(r => !matchedIds.has(r.id));
        newIds.forEach(r => matchedIds.add(r.id));
        console.log('  ' + p.label.padEnd(32) + newIds.length.toString().padStart(5) + '  (' + p.pattern + ')');
        totalToIgnore += newIds.length;
    }

    console.log('');
    console.log(' Subject-mønstre:');
    for (const p of SUBJECT_PATTERNS) {
        const rows = db.prepare(
            "SELECT id FROM mail_unmatched WHERE status='open' AND subject LIKE ?"
        ).all(p.pattern);
        const newIds = rows.filter(r => !matchedIds.has(r.id));
        newIds.forEach(r => matchedIds.add(r.id));
        console.log('  ' + p.label.padEnd(32) + newIds.length.toString().padStart(5) + '  (subject LIKE ' + p.pattern + ')');
        totalToIgnore += newIds.length;
    }

    console.log('  ' + '─'.repeat(50));
    console.log('  ' + 'Total til ignored:'.padEnd(28) + totalToIgnore.toString().padStart(5));
    console.log('');

    const remaining = beforeOpen - totalToIgnore;
    console.log('Mails der STADIG vil være åbne efter oprydning: ' + remaining);
    console.log('  (gennemgås manuelt i CRM Indbakke)');
    console.log('');

    if (!APPLY) {
        console.log('Kør med --apply for at gennemføre opdateringen.');
        return;
    }

    if (matchedIds.size === 0) {
        console.log('Intet at gøre — ingen rows matchede.');
        return;
    }

    console.log('Markerer ' + matchedIds.size + ' mails som ignored...');

    const update = db.prepare(`
        UPDATE mail_unmatched
        SET status = 'ignored',
            handled_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'open'
    `);

    let updated = 0;
    // Wrap i transaction for konsistens
    db.exec('BEGIN');
    try {
        for (const id of matchedIds) {
            const r = update.run(id);
            updated += r.changes;
        }
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        console.error('FEJL — rollback:', err.message);
        process.exit(1);
    }

    const afterOpen = db.prepare("SELECT COUNT(*) AS c FROM mail_unmatched WHERE status='open'").get().c;
    console.log('Færdig — opdaterede ' + updated + ' rows.');
    console.log('Åbne mails efter oprydning: ' + afterOpen);
}

main();
