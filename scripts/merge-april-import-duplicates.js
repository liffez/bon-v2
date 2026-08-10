// scripts/merge-april-import-duplicates.js
// ============================================================
// Engangs-oprydning efter importen 8. april 2026.
//
// ── HVAD DER SKETE ──────────────────────────────────────────────────────────
// Importen skrev navne, e-mail og telefon med et afsluttende linjeskift
// ("leif\n", "lh69@kk.dk\n"). Fordi dens egen dublet-kontrol sammenlignede de
// snavsede værdier, genkendte den ikke de kunder og firmaer der allerede lå i
// systemet — og oprettede nye rækker ved siden af.
//
// Linjeskiftet er derfor ikke skaden, men SPORET efter den. I driften:
//   281 kunder + 95 firmaer med whitespace-fejl
//   267 af 275 snavsede e-mailadresser findes allerede på en anden kunde, ren
//    94 af  95 snavsede firmanavne findes allerede på et andet firma, rent
//
// Konsekvensen er reel: findCustomerByEmail() (services/mailService.js)
// sammenligner eksakt, så en indgående mail rammer dubletten — ikke den kunde
// hvis kort man kigger på. Derfor er en ren trim() IKKE nok: den ville
// efterlade 267 kundepar med samme adresse, hvor `LIMIT 1` vilkårligt vælger.
// Det skal være en SAMMENLÆGNING.
//
// ── HVAD SCRIPTET GØR ───────────────────────────────────────────────────────
//   1. Finder rækker hvis tekstfelter afviger fra deres normaliserede form.
//      Datoen bruges IKKE som filter — defekten er kendetegnet, så en evt.
//      anden import med samme fejl fanges også. Datofordelingen rapporteres.
//   2. Samler rækker i GRUPPER om en nøgle — ikke i par. Importen har kørt
//      flere gange, så samme person kan ligge i fire eksemplarer (fx firma
//      "Stefan Bilfeldt": #3763 og #4004 snavsede, #3764 og #4005 rene, alle
//      med CVR 32342825).
//        kunde → e-mail. Stærk nøgle; to personer deler ikke postkasse.
//        firma → CVR. Navnet alene duer IKKE: privatkunder er oprettet som
//                firmaer, og to mennesker kan hedde det samme. Firmaer uden
//                CVR får kun whitespace ryddet og henvises til merge-wizarden.
//      Kun grupper med mindst én snavset række kommer i spil.
//
//      HVEM OVERLEVER afgøres af HVOR DATAEN HÆNGER — ikke af id-rækkefølgen.
//      Importen lagde den snavsede række FØR den rene i 224 af 267 tilfælde,
//      så "ældst = original" er direkte forkert her. Målt på driften hænger
//      bons, mailtråde og aktiviteter på den rene række i 261 af 267 par, og
//      på den snavsede i 0. Rækkefølgen er tilfældig; dataen er ikke.
//      Bærer MERE END ÉN række i gruppen data, springes hele gruppen over.
//   3. Flytter alt fra taberne over på overleveren, dedupliker kontaktpunkter,
//      og markerer taberne is_active = 0 med en note. Samme konventioner som
//      routes/admin-merge.js: soft delete, aldrig DELETE.
//   4. Normaliserer overleverens egne felter hvis den selv var snavset, rydder
//      op i rækker uden gruppe, og i kontaktpunkter der stadig bærer whitespace.
//
// ── SIKKERHED ───────────────────────────────────────────────────────────────
//   • DRY-RUN som standard. Der skrives først med --apply.
//   • --apply tager altid backup først (VACUUM INTO — WAL-sikker) og printer
//     stien. Ingen backup = ingen skrivning.
//   • Alt sker i ÉN transaktion med invarianter. Fejler bare én, rulles HELE
//     oprydningen tilbage:
//        – antal bons, tilbud, aktiviteter, mailtråde, tokens og
//          kampagnemedlemmer uændret
//        – antal bons der peger på en inaktiv kunde/firma uændret
//        – MÆNGDEN AF KONTAKTOPLYSNINGER uændret: hver distinkt (type,
//          normaliseret værdi) der kunne nås før, kan nås efter. Ingen
//          e-mailadresse eller telefonnummer må forsvinde i en sammenlægning.
//        – antal aktive kunder/firmaer falder med præcis antallet af tabere
//   • Changelog-linje pr. sammenlægning med fuldt JSON-snapshot i payload.
//     Bemærk: action er 'merge_import_dup', IKKE 'merge' — scripts/undo-merge.js
//     forstår kun sit eget snapshot-format og afviser denne pænt. Fortrydelse
//     sker via backup-filen, ikke via undo-merge.
//
// ── BRUG ────────────────────────────────────────────────────────────────────
//   node --experimental-sqlite scripts/merge-april-import-duplicates.js
//   node --experimental-sqlite scripts/merge-april-import-duplicates.js --quiet
//   node --experimental-sqlite scripts/merge-april-import-duplicates.js --apply
//
//   Flag:
//     --apply           skriv rigtigt (uden = dry-run)
//     --customers-only  rør kun kunder
//     --companies-only  rør kun firmaer
//     --quiet           kun opsummering, ingen linje-for-linje
// ============================================================
'use strict';
const path = require('path');
const fs   = require('fs');

// Load .env — samme mønster som scripts/merge-duplicate-bon-lines.js
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
}
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');

const { getDb } = require('../db/database');
const { transaction } = require('../db/compat');

const args           = process.argv.slice(2);
const APPLY          = args.includes('--apply');
const QUIET          = args.includes('--quiet');
const CUSTOMERS_ONLY = args.includes('--customers-only');
const COMPANIES_ONLY = args.includes('--companies-only');

const DO_CUSTOMERS = !COMPANIES_ONLY;
const DO_COMPANIES = !CUSTOMERS_ONLY;

/** Normaliseringsreglen. Ét sted — både opdagelse og skrivning bruger den. */
function norm(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}
function isDirty(s) {
    return s != null && String(s) !== norm(s);
}
const key = (s) => norm(s).toLowerCase();

function backupDb(db) {
    const dir = path.join(path.dirname(path.resolve(process.env.DB_PATH)), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');  // utc-ok: filnavn
    const dest = path.join(dir, `bon-foer-april-import-merge-${stamp}.db`);
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    return dest;
}

// ── Analyse ──────────────────────────────────────────────────────────────────

const CUSTOMER_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'notes'];
const COMPANY_FIELDS  = ['name', 'legal_name', 'email', 'phone', 'invoice_email', 'notes'];

/**
 * Hvor meget forretningsdata hænger på rækken? Det er dét der afgør hvem der
 * overlever — en tom dublet kan altid vige for den række kunderne har handlet
 * med. Kontaktpunkter tælles IKKE med: dem har begge, og de flyttes alligevel.
 */
function weight(db, kind, id) {
    const counts = kind === 'customer'
        ? [['bons', 'customer_id'], ['mail_threads', 'customer_id'], ['crm_activities', 'customer_id'],
           ['quotes', 'customer_id'], ['campaign_members', 'customer_id'], ['booking_tokens', 'customer_id']]
        : [['bons', 'company_id'], ['quotes', 'company_id'], ['customers', 'company_id'],
           ['campaign_members', 'company_id'], ['booking_tokens', 'company_id']];
    let n = 0;
    for (const [table, col] of counts) {
        if (!tableExists(db, table)) continue;
        // Kun AKTIVE kunder tæller under et firma. Ellers ville de kunde-
        // dubletter vi netop har lagt sammen få firmaet til at se "brugt" ud.
        const extra = table === 'customers' ? ' AND is_active = 1' : '';
        n += db.prepare(`SELECT COUNT(*) n FROM "${table}" WHERE ${col} = ?${extra}`).get(id).n;
    }
    return n;
}
/**
 * Nøglen en gruppe samles om.
 *
 * Kunder: e-mail. Stærk nøgle — to personer deler ikke postkasse.
 *
 * Firmaer: CVR når det findes. Navnet ALENE duer ikke, fordi privatkunder er
 * oprettet som firmaer ("Stefan Bilfeldt"), og to forskellige mennesker kan
 * hedde det samme. Grupper uden CVR springes derfor over og henvises til
 * merge-wizarden under CRM → Værktøjer, hvor et menneske afgør det.
 */
/**
 * Er de to navne den samme person?
 *
 * E-mail er en stærk nøgle — men ikke perfekt: institutioner har fælles
 * postkasser, så "Lisbeth Møinichen" og "Mette Steiness" kan dele adresse.
 * Dem må vi ikke smelte sammen til én person.
 *
 * Reglen: navnene er forenelige hvis det ene navns ord alle findes i det
 * andet. Det dækker mellemnavne der er kommet til eller faldet fra
 * ("Charlotte Pedersen" ⊂ "Charlotte Rantanen Pedersen"), men ikke to
 * fremmede. Tomt navn siger ingenting og accepteres.
 */
function namesCompatible(a, b) {
    const folkeligt = (s) => norm(s).toLowerCase()
        .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/å/g, 'aa')
        .replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/).filter(Boolean);
    const ta = folkeligt(a), tb = folkeligt(b);
    if (!ta.length || !tb.length) return true;
    const [kort, lang] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    return kort.every(t => lang.includes(t));
}

function groupKey(kind, row) {
    if (kind === 'customer') return row.email ? 'mail:' + key(row.email) : null;
    if (row.cvr && String(row.cvr).trim()) return 'cvr:' + String(row.cvr).trim();
    return null;
}

/**
 * Vælg overleveren i en gruppe: mest data → den rene → laveste id.
 * Returnerer null hvis MERE END ÉN række bærer data — så skal et menneske se
 * på det, uanset hvor tydeligt de ellers ligner hinanden.
 */
function pickSurvivor(db, kind, group) {
    const vejet = group.map(r => ({ row: r, w: weight(db, kind, r.id), dirty: DIRTY_FIELDS[kind].some(f => isDirty(r[f])) }));
    const medData = vejet.filter(v => v.w > 0);
    if (medData.length > 1) return null;
    if (medData.length === 1) return { winner: medData[0].row, vejet };

    const rene = vejet.filter(v => !v.dirty).sort((a, b) => a.row.id - b.row.id);
    const valgt = (rene[0] || vejet.slice().sort((a, b) => a.row.id - b.row.id)[0]);
    return { winner: valgt.row, vejet };
}

const DIRTY_FIELDS = { customer: CUSTOMER_FIELDS, company: COMPANY_FIELDS };

/**
 * Bygger planen. Rører ikke databasen.
 *
 * Rækkerne hentes bredt og afgøres i JS med norm(), så reglen kun findes ét
 * sted. Kun grupper der indeholder MINDST ÉN snavset række kommer i spil —
 * det er importens skade vi rydder op i, ikke al dublethåndtering i CRM.
 */
function analyse(db, kun = null) {
    const plan = {
        customers: { merges: [], cleanups: [], skips: [] },
        companies: { merges: [], cleanups: [], skips: [] },
        orphanContactPoints: [],
        dates: new Map(),
    };

    const noteDate = (created) => {
        const d = String(created || '').slice(0, 10) || '(ukendt)';
        plan.dates.set(d, (plan.dates.get(d) || 0) + 1);
    };

    const behandl = (kind, table, bucket) => {
        const felter = DIRTY_FIELDS[kind];
        const rows = db.prepare(`SELECT * FROM "${table}" WHERE is_active = 1`).all();

        const grupper = new Map();
        const uden = [];
        for (const r of rows) {
            const k = groupKey(kind, r);
            if (!k) { uden.push(r); continue; }
            if (!grupper.has(k)) grupper.set(k, []);
            grupper.get(k).push(r);
        }

        const snavset = (r) => felter.filter(f => isDirty(r[f]));

        // Rækker uden gruppenøgle kan kun ryddes op — aldrig lægges sammen.
        for (const r of uden) {
            const d = snavset(r);
            if (!d.length) continue;
            noteDate(r.created_at);
            if (kind === 'company') {
                bucket.skips.push({ row: r, dirtyFields: d, cleanOnly: true,
                    reason: 'firma uden CVR — whitespace ryddes, men dubletter skal afgøres i merge-wizarden' });
            }
            bucket.cleanups.push({ row: r, dirtyFields: d });
        }

        for (const [, g] of grupper) {
            const snavsede = g.filter(r => snavset(r).length);
            if (!snavsede.length) continue;              // gruppen er ikke vores ærinde
            for (const r of snavsede) noteDate(r.created_at);

            if (g.length === 1) {
                bucket.cleanups.push({ row: g[0], dirtyFields: snavset(g[0]) });
                continue;
            }

            const valg = pickSurvivor(db, kind, g);
            if (!valg) {
                const beskrivelse = valg === null
                    ? `${g.length} rækker deler nøglen og MERE END ÉN bærer data (${g.map(r => '#' + r.id).join(', ')})`
                    : 'ukendt';
                bucket.skips.push({ row: snavsede[0], dirtyFields: snavset(snavsede[0]),
                    reason: beskrivelse + ' — kræver et menneske' });
                continue;
            }

            const tabere = g.filter(r => r.id !== valg.winner.id);

            // Navnevagt. Nøglen alene er ikke identitet:
            //   kunde → fælles institutions-postkasser gør at to FORSKELLIGE
            //           personer kan dele e-mail.
            //   firma → ét CVR dækker mange afdelinger. Københavns Kommune har
            //           59 rækker på samme nummer, og de ER forskellige enheder.
            // Hedder de ikke det samme, lægger vi dem ikke sammen.
            const navn = kind === 'customer'
                ? (r) => `${r.first_name || ''} ${r.last_name || ''}`
                : (r) => r.name || '';
            const fremmed = tabere.find(l => !namesCompatible(navn(valg.winner), navn(l)));
            if (fremmed) {
                bucket.skips.push({
                    row: fremmed, dirtyFields: snavset(fremmed),
                    reason: (kind === 'customer' ? 'deler e-mail med' : 'deler CVR med')
                          + ` #${valg.winner.id} men hedder noget andet `
                          + `(${show(norm(navn(valg.winner)))} vs ${show(norm(navn(fremmed)))}) `
                          + (kind === 'customer'
                              ? '— formentlig en fælles postkasse, ikke en dublet'
                              : '— formentlig to afdelinger, ikke en dublet'),
                });
                // Ryd whitespace på rækkerne, men lad dem stå som selvstændige.
                for (const r of g) {
                    const d = snavset(r);
                    if (d.length) bucket.cleanups.push({ row: r, dirtyFields: d });
                }
                continue;
            }

            bucket.merges.push({
                winner: valg.winner,
                losers: tabere,
                dirtyFields: snavset(valg.winner),
                why: valg.vejet.map(v => `#${v.row.id}=${v.w}`).join(' '),
            });
        }
    };

    if (DO_CUSTOMERS && kun !== 'company')  behandl('customer', 'customers', plan.customers);
    if (DO_COMPANIES && kun !== 'customer') behandl('company',  'companies', plan.companies);

    // Kontaktpunkter der stadig bærer whitespace efter ovenstående — fx på en
    // ejer der ellers er ren.
    const touched = new Set();
    for (const [kind, b] of [['customer', plan.customers], ['company', plan.companies]]) {
        for (const m of b.merges) {
            touched.add(kind + ':' + m.winner.id);
            for (const l of m.losers) touched.add(kind + ':' + l.id);
        }
        for (const c of b.cleanups) touched.add(kind + ':' + c.row.id);
    }
    for (const cp of db.prepare('SELECT * FROM contact_points WHERE is_active = 1').all()) {
        if (!isDirty(cp.value)) continue;
        if (touched.has(cp.entity_type + ':' + cp.entity_id)) continue;
        plan.orphanContactPoints.push(cp);
    }

    return plan;
}

// ── Invarianter ──────────────────────────────────────────────────────────────

function snapshotInvariants(db) {
    const one = (sql) => db.prepare(sql).get().n;
    const contacts = db.prepare(
        'SELECT kind, value FROM contact_points WHERE is_active = 1'
    ).all().map(r => r.kind + '|' + key(r.value));

    return {
        bons:            one('SELECT COUNT(*) n FROM bons'),
        quotes:          one('SELECT COUNT(*) n FROM quotes'),
        activities:      one('SELECT COUNT(*) n FROM crm_activities'),
        mailThreads:     one('SELECT COUNT(*) n FROM mail_threads'),
        bookingTokens:   one('SELECT COUNT(*) n FROM booking_tokens'),
        campaignMembers: one('SELECT COUNT(*) n FROM campaign_members'),
        bonsOnDeadCustomer: one(`SELECT COUNT(*) n FROM bons b JOIN customers c ON c.id = b.customer_id WHERE c.is_active = 0`),
        bonsOnDeadCompany:  one(`SELECT COUNT(*) n FROM bons b JOIN companies co ON co.id = b.company_id WHERE co.is_active = 0`),
        activeCustomers: one('SELECT COUNT(*) n FROM customers WHERE is_active = 1'),
        activeCompanies: one('SELECT COUNT(*) n FROM companies WHERE is_active = 1'),
        contactSet:      new Set(contacts),
    };
}

function checkInvariants(before, after, plan) {
    const fejl = [];
    const same = (k, label) => {
        if (before[k] !== after[k]) fejl.push(`${label}: ${before[k]} → ${after[k]}`);
    };
    same('bons', 'antal bons');
    same('quotes', 'antal tilbud');
    same('activities', 'antal aktiviteter');
    same('mailThreads', 'antal mailtråde');
    same('bookingTokens', 'antal booking-tokens');
    same('campaignMembers', 'antal kampagnemedlemmer');
    same('bonsOnDeadCustomer', 'bons på inaktiv kunde');
    same('bonsOnDeadCompany', 'bons på inaktivt firma');

    const taberAntal = (b) => b.merges.reduce((s, m) => s + m.losers.length, 0);
    const ventetKunder  = before.activeCustomers - taberAntal(plan.customers);
    const ventetFirmaer = before.activeCompanies - taberAntal(plan.companies);
    if (after.activeCustomers !== ventetKunder) {
        fejl.push(`aktive kunder: ${after.activeCustomers}, ventede ${ventetKunder}`);
    }
    if (after.activeCompanies !== ventetFirmaer) {
        fejl.push(`aktive firmaer: ${after.activeCompanies}, ventede ${ventetFirmaer}`);
    }

    // Det vigtigste: ingen kontaktoplysning må være forsvundet.
    const tabt = [...before.contactSet].filter(v => !after.contactSet.has(v));
    if (tabt.length) {
        fejl.push(`${tabt.length} kontaktoplysning(er) forsvandt, fx: ${tabt.slice(0, 5).join(', ')}`);
    }
    return fejl;
}

// ── Skrivning ────────────────────────────────────────────────────────────────

/**
 * Flytter et kontaktpunkt til overleveren — eller lukker det som dublet.
 *
 * Der er et UNIQUE-indeks på (entity_type, entity_id, kind, value) som også
 * dækker INAKTIVE rækker. Vi må derfor kigge på alle overleverens rækker, ikke
 * kun de aktive — ellers vælter flytningen på en gammel, lukket dublet.
 */
function moveContactPoints(db, entityType, loserId, winnerId, snapshot) {
    const winnerCps = db.prepare(
        `SELECT id, kind, value, is_active FROM contact_points
          WHERE entity_type = ? AND entity_id = ?`
    ).all(entityType, winnerId);
    const winnerKeys = new Map();
    for (const c of winnerCps) {
        // Både den normaliserede nøgle (semantisk dublet) og den eksakte værdi
        // (det indekset faktisk håndhæver).
        winnerKeys.set(c.kind + '|' + key(c.value), c.id);
        winnerKeys.set(c.kind + '|=' + norm(c.value), c.id);
    }

    const loserCps = db.prepare(
        `SELECT * FROM contact_points WHERE entity_type = ? AND entity_id = ? AND is_active = 1`
    ).all(entityType, loserId);

    for (const cp of loserCps) {
        const k = cp.kind + '|' + key(cp.value);
        const eksakt = cp.kind + '|=' + norm(cp.value);
        if (winnerKeys.has(k) || winnerKeys.has(eksakt)) {
            const beholdt = winnerKeys.get(k) ?? winnerKeys.get(eksakt);
            // Overleverens række kan være LUKKET. Lukker vi også taberens,
            // ville oplysningen kun findes på inaktive rækker — altså tabt.
            db.prepare(`UPDATE contact_points SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_active = 0`).run(beholdt);
            db.prepare(
                `UPDATE contact_points SET is_active = 0, is_primary = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
            ).run(cp.id);
            snapshot.contact_points.push({ id: cp.id, action: 'deleted_dup', from: loserId, kept: beholdt, value: cp.value });
        } else {
            // Flyttes OG normaliseres — det er hele pointen med oprydningen.
            db.prepare(
                `UPDATE contact_points
                    SET entity_id = ?, value = ?, is_primary = 0, updated_at = CURRENT_TIMESTAMP
                  WHERE id = ?`
            ).run(winnerId, norm(cp.value), cp.id);
            winnerKeys.set(k, cp.id);
            winnerKeys.set(cp.kind + '|=' + norm(cp.value), cp.id);
            snapshot.contact_points.push({ id: cp.id, action: 'moved', from: loserId, value: cp.value });
        }
    }
}

/**
 * Normaliserer en ejers egne kontaktpunkter, og lukker dem der kolliderer.
 *
 * UNIQUE-indekset dækker også inaktive rækker, så en trimning kan støde ind i
 * en gammel lukket række med præcis den værdi. Sker det, lukkes rækken i
 * stedet for at blive rettet — værdien findes jo allerede på ejeren.
 */
function cleanContactPoints(db, entityType, entityId) {
    const alle = db.prepare(
        `SELECT * FROM contact_points WHERE entity_type = ? AND entity_id = ? ORDER BY id`
    ).all(entityType, entityId);

    const optaget = new Map();   // kind|eksakt-værdi → id  (det indekset håndhæver)
    const setKey  = new Map();   // kind|normaliseret     → id  (semantisk dublet)
    for (const cp of alle) {
        optaget.set(cp.kind + '|' + cp.value, cp.id);
        if (cp.is_active && !setKey.has(cp.kind + '|' + key(cp.value))) {
            setKey.set(cp.kind + '|' + key(cp.value), cp.id);
        }
    }

    const luk = db.prepare(`UPDATE contact_points SET is_active = 0, is_primary = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
    let rettet = 0, lukket = 0;

    for (const cp of alle) {
        if (!cp.is_active) continue;
        const nyVaerdi = norm(cp.value);
        const semantisk = setKey.get(cp.kind + '|' + key(cp.value));
        if (semantisk && semantisk !== cp.id) { luk.run(cp.id); lukket++; continue; }
        if (!isDirty(cp.value)) continue;

        const kollision = optaget.get(cp.kind + '|' + nyVaerdi);
        if (kollision && kollision !== cp.id) {
            // Den række vi viger for kan være LUKKET. Så ville værdien kun
            // findes på en inaktiv række bagefter — altså tabt. Genåbn den.
            db.prepare(`UPDATE contact_points SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_active = 0`).run(kollision);
            luk.run(cp.id); lukket++; continue;
        }

        db.prepare(`UPDATE contact_points SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(nyVaerdi, cp.id);
        optaget.delete(cp.kind + '|' + cp.value);
        optaget.set(cp.kind + '|' + nyVaerdi, cp.id);
        rettet++;
    }
    return { rettet, lukket };
}

const CUSTOMER_MOVES = [
    ['bons', 'customer_id'],
    ['quotes', 'customer_id'],
    ['crm_activities', 'customer_id'],
    ['mail_threads', 'customer_id'],
    ['mail_unmatched', 'linked_customer_id'],
    ['crm_unmatched_emails', 'linked_customer_id'],
    ['booking_tokens', 'customer_id'],
    ['campaign_members', 'customer_id'],
    ['crm_suggestion_snoozes', 'customer_id'],
    ['_old_customer_mails', 'customer_id'],
];

const COMPANY_MOVES = [
    ['customers', 'company_id'],
    ['bons', 'company_id'],
    ['quotes', 'company_id'],
    ['booking_tokens', 'company_id'],
    ['campaign_members', 'company_id'],
    ['_old_customer_mails', 'company_id'],
];

function tableExists(db, name) {
    return !!db.prepare(`SELECT 1 n FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
}

function mergeEntity(db, kind, loser, winner) {
    const isCustomer = kind === 'customer';
    const moves = isCustomer ? CUSTOMER_MOVES : COMPANY_MOVES;
    const snapshot = { kind, loser_id: loser.id, winner_id: winner.id, moves: {}, contact_points: [] };

    for (const [table, col] of moves) {
        if (!tableExists(db, table)) continue;
        const n = db.prepare(`SELECT COUNT(*) n FROM "${table}" WHERE ${col} = ?`).get(loser.id).n;
        if (!n) continue;
        db.prepare(`UPDATE "${table}" SET ${col} = ? WHERE ${col} = ?`).run(winner.id, loser.id);
        snapshot.moves[`${table}.${col}`] = n;
    }

    // 1:1-tabeller: overleverens egen række vinder, taberens fjernes.
    const oneToOne = isCustomer
        ? { table: 'crm_customer_meta', col: 'customer_id' }
        : { table: 'rfm_scores',        col: 'company_id' };
    if (tableExists(db, oneToOne.table)) {
        const winnerHas = db.prepare(`SELECT 1 n FROM "${oneToOne.table}" WHERE ${oneToOne.col} = ?`).get(winner.id);
        const loserHas  = db.prepare(`SELECT 1 n FROM "${oneToOne.table}" WHERE ${oneToOne.col} = ?`).get(loser.id);
        if (loserHas) {
            if (winnerHas) {
                db.prepare(`DELETE FROM "${oneToOne.table}" WHERE ${oneToOne.col} = ?`).run(loser.id);
                snapshot.moves[`${oneToOne.table} (slettet dublet)`] = 1;
            } else {
                db.prepare(`UPDATE "${oneToOne.table}" SET ${oneToOne.col} = ? WHERE ${oneToOne.col} = ?`).run(winner.id, loser.id);
                snapshot.moves[oneToOne.table] = 1;
            }
        }
    }

    // Polymorfe tabeller uden FK.
    for (const table of ['changelog', 'entity_flags']) {
        if (!tableExists(db, table)) continue;
        const n = db.prepare(`SELECT COUNT(*) n FROM "${table}" WHERE entity_type = ? AND entity_id = ?`).get(kind, loser.id).n;
        if (!n) continue;
        db.prepare(`UPDATE "${table}" SET entity_id = ? WHERE entity_type = ? AND entity_id = ?`).run(winner.id, kind, loser.id);
        snapshot.moves[`${table} (${kind})`] = n;
    }

    moveContactPoints(db, kind, loser.id, winner.id, snapshot);

    // Overleveren kan selv være den snavsede (når dataen hang på den) — så
    // skal DENS felter normaliseres, ellers har vi flyttet fejlen i stedet
    // for at fjerne den.
    const winnerFields = (isCustomer ? CUSTOMER_FIELDS : COMPANY_FIELDS).filter(f => isDirty(winner[f]));
    if (winnerFields.length) {
        const sets = winnerFields.map(f => `${f} = ?`);
        const vals = winnerFields.map(f => norm(winner[f]));
        db.prepare(
            `UPDATE "${isCustomer ? 'customers' : 'companies'}"
                SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(...vals, winner.id);
        snapshot.winner_cleaned = winnerFields;
    }
    snapshot.winner_contact_points = cleanContactPoints(db, kind, winner.id);

    // Taberen lukkes — aldrig DELETE, samme konvention som admin-merge.
    const table = isCustomer ? 'customers' : 'companies';
    const note = `\n[Dublet fra import — sammenlagt med #${winner.id}]`;
    db.prepare(
        `UPDATE "${table}" SET is_active = 0, notes = COALESCE(notes,'') || ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(note, loser.id);

    db.prepare(
        `INSERT INTO changelog (entity_type, entity_id, action, field_name, old_value, new_value, notes, payload)
         VALUES (?, ?, 'merge_import_dup', 'id', ?, ?, ?, ?)`
    ).run(kind, winner.id, String(loser.id), String(winner.id),
          `Dublet #${loser.id} fra importen sammenlagt ind i #${winner.id}`,
          JSON.stringify(snapshot));

    return snapshot;
}

function cleanEntity(db, kind, row, dirtyFields) {
    const table = kind === 'customer' ? 'customers' : 'companies';
    const sets = [], vals = [], aendret = {};
    for (const f of dirtyFields) {
        sets.push(`${f} = ?`);
        vals.push(norm(row[f]));
        aendret[f] = { foer: row[f], efter: norm(row[f]) };
    }
    if (sets.length) {
        db.prepare(`UPDATE "${table}" SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...vals, row.id);
    }
    const cp = cleanContactPoints(db, kind, row.id);
    db.prepare(
        `INSERT INTO changelog (entity_type, entity_id, action, field_name, notes, payload)
         VALUES (?, ?, 'cleanup_whitespace', ?, ?, ?)`
    ).run(kind, row.id, dirtyFields.join(','),
          'Whitespace fjernet fra importerede felter',
          JSON.stringify({ fields: aendret, contact_points: cp }));
    return cp;
}

// ── Rapport ──────────────────────────────────────────────────────────────────

function show(v) { return JSON.stringify(String(v == null ? '' : v)); }

function printPlan(plan) {
    const c = plan.customers, co = plan.companies;

    if (plan.dates.size) {
        const datoer = [...plan.dates.entries()].sort();
        console.log('\nBerørte rækker pr. oprettelsesdato:');
        for (const [d, n] of datoer) console.log(`  ${d}  ${n}`);
        if (datoer.length > 1) {
            console.log('  ⚠ Mere end én dato — det er ikke kun april-importen. Læs listen igennem.');
        }
    }

    if (!QUIET) {
        for (const [label, merges] of [['KUNDER', c.merges], ['FIRMAER', co.merges]]) {
            if (!merges.length) continue;
            console.log(`\n${label} — sammenlægges (${merges.length}):`);
            for (const m of merges.slice(0, QUIET ? 0 : 200)) {
                const navn = m.winner.name || `${m.winner.first_name || ''} ${m.winner.last_name || ''}`;
                console.log(`  ${m.losers.map(l => '#' + l.id).join(' + ')} → #${m.winner.id} ${show(norm(navn))}   (${m.why})`);
            }
            if (merges.length > 200) console.log(`  … og ${merges.length - 200} mere`);
        }
        for (const [label, cleanups] of [['KUNDER', c.cleanups], ['FIRMAER', co.cleanups]]) {
            if (!cleanups.length) continue;
            console.log(`\n${label} — ryddes kun op, ingen tvilling (${cleanups.length}):`);
            for (const x of cleanups) {
                const navn = x.row.name || `${x.row.first_name || ''} ${x.row.last_name || ''}`;
                console.log(`  #${x.row.id} ${show(navn)}   [${x.dirtyFields.join(', ')}]`);
            }
        }
    }

    for (const [label, skips] of [['KUNDER', c.skips], ['FIRMAER', co.skips]]) {
        if (!skips.length) continue;
        console.log(`\n${label} — SPRINGES OVER, kræver et menneske (${skips.length}):`);
        for (const s of skips) {
            const navn = s.row.name || `${s.row.first_name || ''} ${s.row.last_name || ''}`;
            console.log(`  #${s.row.id} ${show(navn)} — ${s.reason}`);
        }
    }

    if (plan.orphanContactPoints.length) {
        console.log(`\nKontaktpunkter med whitespace på ellers rene ejere: ${plan.orphanContactPoints.length}`);
    }

    console.log('\n── Opsummering ────────────────────────────────');
    console.log(`  Kunder:   ${c.merges.length} sammenlægges · ${c.cleanups.length} ryddes op · ${c.skips.length} springes over`);
    console.log(`  Firmaer:  ${co.merges.length} sammenlægges · ${co.cleanups.length} ryddes op · ${co.skips.length} springes over`);
    console.log(`  Løse kontaktpunkter: ${plan.orphanContactPoints.length}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
    const db = getDb();
    console.log(`Database: ${path.resolve(process.env.DB_PATH)}`);
    console.log(APPLY ? 'Tilstand:  APPLY — der skrives\n' : 'Tilstand:  DRY-RUN — der skrives ikke (brug --apply)\n');

    // Backup FØR transaktionen (VACUUM INTO kan ikke køre inde i en).
    const backup = APPLY ? backupDb(db) : null;
    if (backup) console.log(`Backup: ${backup}\n`);

    // Både dry-run og apply kører den ÆGTE oprydning i en transaktion.
    // Dry-run ruller bare tilbage til sidst. Det er den eneste måde at vise
    // firma-planen rigtigt på: firmaernes "er den i brug?" afhænger af om
    // kunde-dubletterne allerede er lagt sammen.
    let resultat = null, fejl = [];
    const before = snapshotInvariants(db);

    db.exec('BEGIN');
    try {
        let merged = 0, cleaned = 0, cpRettet = 0, cpLukket = 0;

        // ── Fase 1: kunder ──
        const kundePlan = analyse(db, 'customer');
        for (const m of kundePlan.customers.merges) {
            for (const l of m.losers) { mergeEntity(db, 'customer', l, m.winner); merged++; }
        }
        for (const x of kundePlan.customers.cleanups) {
            const r = cleanEntity(db, 'customer', x.row, x.dirtyFields); cleaned++; cpRettet += r.rettet; cpLukket += r.lukket;
        }

        // ── Fase 2: firmaer — vurderes FØRST nu, hvor kunderne er lagt sammen ──
        const firmaPlan = analyse(db, 'company');
        for (const m of firmaPlan.companies.merges) {
            for (const l of m.losers) { mergeEntity(db, 'company', l, m.winner); merged++; }
        }
        for (const x of firmaPlan.companies.cleanups) {
            const r = cleanEntity(db, 'company', x.row, x.dirtyFields); cleaned++; cpRettet += r.rettet; cpLukket += r.lukket;
        }

        // ── Fase 3: løse kontaktpunkter ──
        const rest = analyse(db, 'ingen');
        for (const cp of rest.orphanContactPoints) {
            const r = cleanContactPoints(db, cp.entity_type, cp.entity_id); cpRettet += r.rettet; cpLukket += r.lukket;
        }

        const samlet = {
            customers: kundePlan.customers,
            companies: firmaPlan.companies,
            orphanContactPoints: rest.orphanContactPoints,
            dates: new Map([...kundePlan.dates, ...firmaPlan.dates]),
        };
        printPlan(samlet);

        const after = snapshotInvariants(db);
        fejl = checkInvariants(before, after, samlet);
        if (fejl.length) throw new Error('Invarianter brudt:\n  - ' + fejl.join('\n  - '));

        resultat = { merged, cleaned, cpRettet, cpLukket };

        if (APPLY) { db.exec('COMMIT'); }
        else       { db.exec('ROLLBACK'); }
    } catch (err) {
        db.exec('ROLLBACK');
        throw new Error(err.message + '\n  → Alt er rullet tilbage. Databasen er urørt.');
    }

    if (!resultat.merged && !resultat.cleaned && !resultat.cpRettet && !resultat.cpLukket) {
        console.log('\nIntet at rydde op. ✓');
        return;
    }

    if (APPLY) {
        console.log('\n✓ Gennemført.');
        console.log(`  ${resultat.merged} rækker sammenlagt · ${resultat.cleaned} ryddet op`);
        console.log(`  Kontaktpunkter: ${resultat.cpRettet} normaliseret · ${resultat.cpLukket} lukket som dublet`);
        console.log(`  Fortryd ved at lægge backuppen tilbage: ${backup}`);
    } else {
        console.log('\nDRY-RUN — alt er rullet tilbage, databasen er urørt.');
        console.log(`  Ville lægge ${resultat.merged} rækker sammen og rydde op i ${resultat.cleaned}.`);
        console.log('  Kør med --apply når listen ser rigtig ud.');
    }
}

try {
    main();
} catch (err) {
    console.error('\n✗ ' + err.message);
    process.exitCode = 1;
}
