#!/usr/bin/env node
/**
 * scripts/seed-overlapping-events.js — LOKALT TESTVÆRKTØJ
 * ════════════════════════════════════════════════════════════
 * Opretter to events der overlapper i datoer, med vagter i vagtplan-spejlet,
 * så fordelingen (§18.3d) kan prøves uden at vente på at det sker i drift.
 *
 * Vagterne skrives til `smartplan_shifts` i samme rå form som synkroniseringen
 * leverer — så det er den ÆGTE kodesti der testes, ikke en attrap.
 *
 * Nægter at køre med NODE_ENV=production. Alt hedder "SEED " og kan fjernes
 * igen med --remove.
 *
 * Kør:  node --experimental-sqlite scripts/seed-overlapping-events.js --apply
 *       node --experimental-sqlite scripts/seed-overlapping-events.js --remove
 * ════════════════════════════════════════════════════════════
 */

if (process.env.NODE_ENV === 'production') {
    console.error('✋ Nægter at køre med NODE_ENV=production — dette er kun et lokalt testværktøj.');
    process.exit(2);
}

const { openDb } = require('../db/compat');

const DB_PATH = process.env.DB_PATH || './data/bon.db';
const argv    = process.argv.slice(2);
const apply   = argv.includes('--apply');
const remove  = argv.includes('--remove');
const PREFIX  = 'SEED ';

if (!apply && !remove) {
    console.log(`
  Opretter to overlappende events med vagter, så fordelingen kan prøves.

    --apply    opret
    --remove   fjern igen (alt der hedder "${PREFIX}…")
`);
    process.exit(0);
}

const db = openDb(DB_PATH);

/* ── Fjern ───────────────────────────────────────────────── */

if (remove) {
    const ids = db.prepare(`SELECT id FROM events WHERE name LIKE '${PREFIX}%'`).all().map(r => r.id);
    db.exec('BEGIN IMMEDIATE');
    try {
        db.prepare(`DELETE FROM smartplan_shifts WHERE uuid LIKE 'seed-%'`).run();
        db.prepare(`DELETE FROM event_shift_assignments WHERE shift_uuid LIKE 'seed-%'`).run();
        db.prepare(`DELETE FROM wage_rates WHERE smartplan_ref LIKE 'seed-%'`).run();
        db.prepare(`DELETE FROM smartplan_role_map WHERE jobtype_uuid = 'seed-jt'`).run();
        for (const id of ids) {
            db.prepare('DELETE FROM event_labor WHERE event_id = ?').run(id);
            db.prepare("DELETE FROM changelog WHERE entity_type = 'event' AND entity_id = ?").run(id);
            db.prepare('DELETE FROM events WHERE id = ?').run(id);
        }
        db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    console.log(`\n✓ Fjernet ${ids.length} seed-event(s) og deres vagter.\n`);
    db.close();
    process.exit(0);
}

/* ── Opret ───────────────────────────────────────────────── */

// Dansk kalenderdato — ikke toISOString, som giver UTC og altså gårsdagen
// mellem midnat og kl. 02 (#133).
const dk = (offset = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(d);
};

const LOR = dk(3), SON = dk(4);   // en weekend et par dage ude i fremtiden

const locId = db.prepare('SELECT id FROM locations LIMIT 1').get()?.id;
if (!locId) { console.error('Ingen lokationer i databasen.'); process.exit(1); }

// Hvilken lokation regnes som event? Alt der IKKE er HQ-navnet (migration 122).
const hq = db.prepare("SELECT value FROM settings WHERE key = 'smartplan_hq_location'").get()?.value
        || 'Ristet Rug';
const EVENT_LOC = hq === 'Festivaler og Events' ? 'Festivaler og Events 2' : 'Festivaler og Events';

const FOLK = [
    { ref: 'seed-u1', fornavn: 'Anne',   efter: 'Seed', sats: 150 },
    { ref: 'seed-u2', fornavn: 'Leif',   efter: 'Seed', sats: 145 },
    { ref: 'seed-u3', fornavn: 'Marie',  efter: 'Seed', sats: 160 },
    { ref: 'seed-u4', fornavn: 'Rebecca', efter: 'Seed', sats: 145 },
];

// (person, dag) — bevidst blandet: begge dage, begge events, og én uden sats
// så advarslen om manglende timeløn også kan ses.
const VAGTER = [
    { p: 0, dag: LOR, fra: '08:00', til: '16:00' },
    { p: 1, dag: LOR, fra: '09:00', til: '17:00' },
    { p: 2, dag: LOR, fra: '10:00', til: '18:00' },
    { p: 0, dag: SON, fra: '08:00', til: '15:00' },
    { p: 3, dag: SON, fra: '09:00', til: '17:00' },
];

const iso = (dag, tid) => `${dag}T${tid}:00Z`;
const timer = (fra, til) =>
    (Number(til.slice(0, 2)) * 60 + Number(til.slice(3)) - Number(fra.slice(0, 2)) * 60 - Number(fra.slice(3))) * 60;

db.exec('BEGIN IMMEDIATE');
try {
    const mkEvent = (navn, fra, til) => Number(db.prepare(`
        INSERT INTO events (name, location_id, model, start_date, end_date, status, notes)
        VALUES (?,?, 'light', ?, ?, 'active', 'Oprettet af seed-overlapping-events.js — kan fjernes med --remove')
    `).run(PREFIX + navn, locId, fra, til).lastInsertRowid);

    const a = mkEvent('Vig Festival', LOR, SON);
    const b = mkEvent('Smukfest', LOR, SON);

    db.prepare(`INSERT OR IGNORE INTO smartplan_role_map (jobtype_uuid, jobtype_title, role_class)
                VALUES ('seed-jt', 'Salgsassistent (seed)', 'production')`).run();

    const wr = db.prepare(`INSERT OR IGNORE INTO wage_rates (smartplan_ref, employee_name, hourly_rate, valid_from)
                           VALUES (?,?,?, '2025-01-01')`);
    // Rebecca får BEVIDST ingen sats — så advarslen "mangler en timeløn" kan ses.
    for (const f of FOLK.slice(0, 3)) wr.run(f.ref, `${f.fornavn} ${f.efter}`, f.sats);

    const ins = db.prepare(`INSERT INTO smartplan_shifts (uuid, source, date, raw_json, synced_at)
                            VALUES (?, 'shift', ?, ?, datetime('now'))`);
    VAGTER.forEach((v, i) => {
        const f = FOLK[v.p];
        const uuid = `seed-s${i + 1}`;
        ins.run(uuid, v.dag, JSON.stringify({
            uuid,
            display_date: v.dag,
            owner: { uuid: f.ref, first_name: f.fornavn, last_name: f.efter },
            jobtype: { uuid: 'seed-jt', title: 'Salgsassistent (seed)' },
            location: { title: EVENT_LOC },
            planned_start_dt: iso(v.dag, v.fra),
            planned_end_dt: iso(v.dag, v.til),
            planned_shift_duration: timer(v.fra, v.til),
            // Vagtplan-visningen læser start_dt/end_dt (de FAKTISKE tider), ikke
            // planned_*. Uden dem stod seed-vagterne uden tidspunkter og så
            // ufærdige ud ved siden af de rigtige.
            start_dt: iso(v.dag, v.fra),
            end_dt: iso(v.dag, v.til),
            note: '',
        }));
    });

    db.exec('COMMIT');

    console.log(`
✓ Oprettet to overlappende events (${LOR} – ${SON}):

    #${a}  ${PREFIX}Vig Festival
    #${b}  ${PREFIX}Smukfest

  ${VAGTER.length} vagter lagt i vagtplan-spejlet på lokationen "${EVENT_LOC}".
  Rebecca har BEVIDST ingen timeløn — så advarslen om manglende sats kan ses.

  Åbn ét af dem i Events → panelet "Vagtplan & opsætning". Begge events tæller
  lige nu de samme vagter (det er fejlen), og der står en advarsel om det.
  Fordel vagterne i dropdown'en, og se summerne flytte sig.

  Ryd op igen:  node --experimental-sqlite scripts/seed-overlapping-events.js --remove
`);
} catch (e) {
    db.exec('ROLLBACK');
    throw e;
}
db.close();
