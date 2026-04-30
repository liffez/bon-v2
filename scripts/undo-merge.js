#!/usr/bin/env node
/**
 * undo-merge.js — Ruller en firma-merge tilbage.
 *
 * Brug:
 *   node --experimental-sqlite scripts/undo-merge.js <changelog_id> [--dry-run]
 *
 * Læser changelog-rækken med action='merge', parser snapshot fra notes (JSON),
 * og fører customers/bons/booking_tokens/contact_points tilbage til loser.
 * Genaktiverer loser (is_active=1) og fjerner dens navn fra winner.alternate_names.
 *
 * Sanity-tjek før rollback:
 *   - Changelog-rækken skal eksistere og ikke være rolled_back_at-stamped
 *   - Winner og loser skal stadig findes
 *   - Hvis nogen flyttede rækker er flyttet videre til et tredje firma siden,
 *     logges warning og rækken springes over (rollbackes ikke videre)
 *
 * Begrænsninger:
 *   - Bons der har fået ekstra linjer eller status-skift efter merge bevares —
 *     kun company_id rulles tilbage
 *   - Nye contact_points oprettet på winner efter merge bevares
 *   - Hvis loser hård-slettes (sker ikke fra UI), kan rollback ikke gennemføres
 */

const path = require('path');
const { openDb, transaction } = require('../db/compat');

// .env loader
try {
    const envPath = path.join(__dirname, '..', '.env');
    const fs = require('fs');
    if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of lines) {
            const m = line.match(/^([^#=]+)=(.*)$/);
            if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
        }
    }
} catch {}

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const changelogId = parseInt(args.find(a => /^\d+$/.test(a)) || '0', 10);

if (!changelogId) {
    console.log('Brug: node --experimental-sqlite scripts/undo-merge.js <changelog_id> [--dry-run]');
    process.exit(1);
}

const db = openDb(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

// ─── Hent changelog ────────────────────────────────────────

const cl = db.prepare(`
    SELECT id, entity_id, action, notes, rolled_back_at, created_at
      FROM changelog
     WHERE id = ?
`).get(changelogId);

if (!cl) {
    console.error(`✗ Changelog #${changelogId} findes ikke.`);
    process.exit(2);
}
if (cl.action !== 'merge') {
    console.error(`✗ Changelog #${changelogId} er ikke en merge (action='${cl.action}').`);
    process.exit(2);
}
if (cl.rolled_back_at) {
    console.error(`✗ Merge er allerede rullet tilbage ${cl.rolled_back_at}.`);
    process.exit(2);
}

let payload;
try {
    payload = JSON.parse(cl.notes);
} catch (err) {
    console.error('✗ Kan ikke parse snapshot fra changelog.notes:', err.message);
    process.exit(2);
}

if (payload.schema_version !== 1) {
    console.error(`✗ Ukendt schema_version ${payload.schema_version}. Scriptet kender kun version 1.`);
    process.exit(2);
}

const { winner_id, loser_id, snapshot } = payload;

console.log(`Rollback af merge #${changelogId}`);
console.log(`  Winner: #${winner_id}`);
console.log(`  Loser:  #${loser_id} (${snapshot.loser_row?.name})`);
console.log(`  Oprettet: ${cl.created_at}`);

// ─── Sanity-tjek ────────────────────────────────────────────

const winner = db.prepare('SELECT * FROM companies WHERE id = ?').get(winner_id);
const loser  = db.prepare('SELECT * FROM companies WHERE id = ?').get(loser_id);

if (!winner) {
    console.error(`✗ Winner-firma #${winner_id} findes ikke længere — kan ikke rulle tilbage.`);
    process.exit(3);
}
if (!loser) {
    console.error(`✗ Loser-firma #${loser_id} findes ikke længere — kan ikke rulle tilbage.`);
    process.exit(3);
}

// Tjek om flyttede rækker stadig peger på winner (ellers er de flyttet videre)
const warnings = [];
let pendingCustomers = 0, pendingBons = 0, pendingBookingTokens = 0, pendingCps = 0;

for (const m of snapshot.moved_customers || []) {
    const c = db.prepare('SELECT company_id FROM customers WHERE id = ?').get(m.id);
    if (!c) {
        warnings.push(`Kunde #${m.id} findes ikke længere — springes over.`);
    } else if (c.company_id !== winner_id) {
        warnings.push(`Kunde #${m.id} er flyttet videre til firma #${c.company_id} — springes over.`);
    } else {
        pendingCustomers++;
    }
}
for (const m of snapshot.moved_bons || []) {
    const b = db.prepare('SELECT company_id FROM bons WHERE id = ?').get(m.id);
    if (!b) warnings.push(`Bon #${m.id} findes ikke længere — springes over.`);
    else if (b.company_id !== winner_id) warnings.push(`Bon #${m.id} er flyttet videre til firma #${b.company_id} — springes over.`);
    else pendingBons++;
}
for (const m of snapshot.moved_booking_tokens || []) {
    const t = db.prepare('SELECT company_id FROM booking_tokens WHERE token = ?').get(m.token);
    if (!t) warnings.push(`Booking-token ${m.token?.slice(0,8)}… findes ikke længere.`);
    else if (t.company_id !== winner_id) warnings.push(`Booking-token ${m.token?.slice(0,8)}… flyttet videre — springes over.`);
    else pendingBookingTokens++;
}
for (const cpMove of snapshot.moved_contact_points || []) {
    if (cpMove.action === 'moved') {
        const cp = db.prepare('SELECT entity_id, is_active FROM contact_points WHERE id = ?').get(cpMove.id);
        if (!cp) warnings.push(`Contact_point #${cpMove.id} findes ikke længere.`);
        else if (cp.entity_id !== winner_id) warnings.push(`Contact_point #${cpMove.id} flyttet videre — springes over.`);
        else if (cp.is_active === 0) warnings.push(`Contact_point #${cpMove.id} er deaktiveret efterfølgende — springes over.`);
        else pendingCps++;
    } else if (cpMove.action === 'deleted_dup') {
        // Skal genskabes som ny række
        pendingCps++;
    }
}

console.log('');
console.log('Plan:');
console.log(`  Kunder der ruller tilbage:        ${pendingCustomers} af ${snapshot.moved_customers?.length || 0}`);
console.log(`  Bons der ruller tilbage:          ${pendingBons} af ${snapshot.moved_bons?.length || 0}`);
console.log(`  Booking-tokens der ruller tilbage:${pendingBookingTokens} af ${snapshot.moved_booking_tokens?.length || 0}`);
console.log(`  Contact_points der ruller tilbage:${pendingCps} af ${snapshot.moved_contact_points?.length || 0}`);
console.log(`  Loser genaktiveres:               #${loser_id} (${loser.name})`);
console.log(`  Winner.alternate_names:           taber-navn fjernes`);

if (warnings.length > 0) {
    console.log('');
    console.log('Warnings:');
    for (const w of warnings) console.log(`  ⚠ ${w}`);
}

if (dryRun) {
    console.log('');
    console.log('🔍 DRY RUN — intet ændret.');
    process.exit(0);
}

// ─── Udfør rollback ─────────────────────────────────────────

console.log('');
console.log('🔧 Udfører rollback...');

try {
    transaction(db, () => {
        // Kunder
        const moveCust = db.prepare('UPDATE customers SET company_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?');
        for (const m of snapshot.moved_customers || []) moveCust.run(loser_id, m.id, winner_id);

        // Bons
        const moveBon = db.prepare('UPDATE bons SET company_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?');
        for (const m of snapshot.moved_bons || []) moveBon.run(loser_id, m.id, winner_id);

        // Booking tokens
        const moveTok = db.prepare('UPDATE booking_tokens SET company_id = ? WHERE token = ? AND company_id = ?');
        for (const m of snapshot.moved_booking_tokens || []) moveTok.run(loser_id, m.token, winner_id);

        // RFM_scores: hvis vi flyttede til winner og winner ikke havde, rul tilbage.
        // Hvis vi slettede loser's pga. winner havde, kan vi ikke rekonstruere uden snapshot.rfm_scores —
        // genskab fra snapshot (best effort).
        if ((snapshot.rfm_scores || []).length > 0) {
            const winnerRfm = db.prepare('SELECT 1 FROM rfm_scores WHERE company_id = ?').get(winner_id);
            if (winnerRfm) {
                // Winner har en — kan være loser's flyttede ELLER vinderens egen.
                // Hvis vinderens egen var der før merge, skal loser-snapshot indsættes som ny række.
                // Vi gør det enkleste: re-insert fra snapshot (id-konflikt undgås hvis loser_rfm.id ikke findes mere).
                for (const r of snapshot.rfm_scores) {
                    const exists = db.prepare('SELECT 1 FROM rfm_scores WHERE company_id = ?').get(loser_id);
                    if (!exists) {
                        const cols = Object.keys(r).filter(k => k !== 'id').join(', ');
                        const placeholders = Object.keys(r).filter(k => k !== 'id').map(() => '?').join(', ');
                        const vals = Object.entries(r).filter(([k]) => k !== 'id').map(([, v]) => v);
                        try {
                            db.prepare(`INSERT INTO rfm_scores (${cols}) VALUES (${placeholders})`).run(...vals);
                        } catch (e) {
                            console.warn(`  ⚠ kunne ikke genskabe rfm_scores-række: ${e.message}`);
                        }
                    }
                }
            } else {
                // Winner har ingen — flyt tilbage
                db.prepare('UPDATE rfm_scores SET company_id = ? WHERE company_id = ?').run(loser_id, winner_id);
            }
        }

        // Contact_points
        for (const cpMove of snapshot.moved_contact_points || []) {
            if (cpMove.action === 'moved') {
                db.prepare(`
                    UPDATE contact_points
                       SET entity_id = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ? AND entity_id = ? AND is_active = 1
                `).run(loser_id, cpMove.id, winner_id);
            } else if (cpMove.action === 'deleted_dup') {
                // Genskab — først tjek om den allerede er reaktiveret
                const existing = db.prepare(`
                    SELECT id FROM contact_points
                     WHERE entity_type = 'company' AND entity_id = ?
                       AND kind = ? AND value = ?
                `).get(loser_id, cpMove.snapshot_value.kind, cpMove.snapshot_value.value);
                if (existing) {
                    db.prepare('UPDATE contact_points SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(existing.id);
                } else {
                    const v = cpMove.snapshot_value;
                    db.prepare(`
                        INSERT INTO contact_points
                            (entity_type, entity_id, kind, value, source, is_public, is_primary,
                             purpose, verified_at, last_seen_at, is_active, notes)
                        VALUES ('company', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                    `).run(
                        loser_id, v.kind, v.value, v.source, v.is_public ?? 0, v.is_primary ?? 0,
                        v.purpose ?? null, v.verified_at ?? null, v.last_seen_at ?? null, v.notes ?? null
                    );
                }
            }
        }

        // Restore winner-felter fra snapshot (kun de felter der var i field_choices)
        const wRow = snapshot.winner_row;
        const fieldChoices = snapshot.applied_field_choices || {};
        const restoreClauses = [];
        const restoreArgs = [];
        for (const field of Object.keys(fieldChoices)) {
            if (!(field in wRow)) continue;
            restoreClauses.push(`${field} = ?`);
            restoreArgs.push(wRow[field]);
        }
        // Reset alternate_names: behold winner's oprindelige + fjern alle navne
        // der blev tilføjet under merge (loser.name + loser's egne alternate_names).
        const winnerOriginalAlts = JSON.parse(snapshot.winner_row.alternate_names || '[]');
        restoreClauses.push('alternate_names = ?');
        restoreArgs.push(winnerOriginalAlts.length > 0 ? JSON.stringify(winnerOriginalAlts) : null);

        if (restoreClauses.length > 0) {
            restoreArgs.push(winner_id);
            db.prepare(`UPDATE companies SET ${restoreClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...restoreArgs);
        }

        // Genaktivér loser
        // Fjern den "[Sammenlagt med firma #X ...]"-note fra notes
        const cleanedNotes = (loser.notes || '').replace(
            new RegExp('\\n?\\[Sammenlagt med firma #' + winner_id + '[^\\]]*\\]', 'g'),
            ''
        ).trim() || null;
        db.prepare(`
            UPDATE companies
               SET is_active = 1, notes = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?
        `).run(cleanedNotes, loser_id);

        // Markér changelog som rulled tilbage + skriv ny changelog
        db.prepare('UPDATE changelog SET rolled_back_at = CURRENT_TIMESTAMP WHERE id = ?').run(changelogId);
        db.prepare(`
            INSERT INTO changelog (entity_type, entity_id, action, notes, created_at)
            VALUES ('company', ?, 'merge_rollback', ?, CURRENT_TIMESTAMP)
        `).run(loser_id, JSON.stringify({ original_changelog_id: changelogId, winner_id, loser_id }));
    });

    console.log('');
    console.log('✅ Rollback gennemført.');
    console.log(`   Loser-firma #${loser_id} (${loser.name}) er aktiv igen.`);
    console.log(`   Kunder/bons/contact_points peger igen på #${loser_id}.`);
} catch (err) {
    console.error('✗ Rollback fejlede:', err);
    process.exit(4);
}
