// scripts/fix-bounced-emails.js
// ============================================================
// Engangs-oprydning: retter kunde-adresser der beviseligt ikke virker, og
// lukker testrækker.
//
// ── HVOR LISTEN KOMMER FRA ──────────────────────────────────────────────────
// De 47 bounces i mail_unmatched blev gennemgået. Mailserveren fortæller i
// hvert enkelt tilfælde HVORFOR, og det deler dem i fire slags. Kun to af dem
// kan et script håndtere:
//
//   ✔ "Host or domain name not found"  → domænet er stavet forkert.
//     Rettes her — og kun når den rigtige adresse allerede findes i systemet
//     på en anden række, så det ikke er et gæt.
//   ✔ testrækker uden bons, tråde eller aktiviteter → lukkes.
//
//   ✘ "550 5.4.1 Recipient address rejected" → personen har forladt stedet.
//     Der er ingen stavefejl at rette; nogen skal ringe. Rører vi ikke.
//     (#2996 Lisbeth Møinichen / ma@lf.dk — 17 bons, værd at få fat i.
//      #4017 Eline Østergaard / peo@danner.dk)
//   ✘ "552 5.2.2 Mailbox is full" → adressen er RIGTIG, postkassen var stopfuld.
//     (#4151 Niels Jerl / info@nielsjerl.dk) Rører vi ikke.
//   ✘ #3910 Ida Devald / ida@danner.dl — ".dl" skal være ".dk", men Danner
//     bruger initialer (naf@, shs@, azm@), ikke fornavne. "ida@danner.dk" ville
//     være et gæt. Rører vi ikke.
//
// ── DUBLETTERNE BAGEFTER ────────────────────────────────────────────────────
// Når adressen er rettet, deler rækken adresse med den der allerede havde den
// rigtige. merge-april-import-duplicates.js springer alle tre over — den nægter
// at lægge sammen når efternavnene staves forskelligt eller begge rækker bærer
// ordrer. Det er korrekt af den; det er en menneskeafgørelse.
//
// Leif har truffet den (10. august 2026):
//   ✔ #3276 "Alice Jacobsen" (1 bon)  →  #3553 "Alice Jacobsen" (20 bons)
//     Samme person.
//   ✔ #4192 "Eric Rodgers Vetch" (1 bon)  →  #3149 "Eric Rodgers Veitch" (27 bons)
//     "Vetch" er en stavefejl; "Veitch" er det rigtige. Derfor overlever #3149.
//   ✘ #3886 "rikke thomsen" og #3409 "Rikke Pape" er TO FORSKELLIGE personer.
//     De lægges ikke sammen. Adressen på #3886 rettes, og de to bliver ved med
//     at dele den — det er i orden, de arbejder samme sted.
//
// RÆKKEFØLGEN ER IKKE LIGEGYLDIG: adressen rettes FØR sammenlægningen, også på
// de rækker der lukkes bagefter. Ellers ville mergeEntity flytte den DØDE
// adresse over på overleveren som et ekstra, aktivt kontaktpunkt — og så havde
// vi givet Eric og Alice en adresse der bouncer.
//
// Sammenlægningen bruger mergeEntity fra merge-april-import-duplicates.js, så
// der kun findes ét sted der afgør hvad der følger med en kunde over.
//
// ── SIKKERHED ───────────────────────────────────────────────────────────────
//   • DRY-RUN som standard; --apply skriver.
//   • --apply tager backup (VACUUM INTO) først og printer stien.
//   • Alt i ÉN transaktion. Dry-run kører det ægte arbejde og ruller tilbage,
//     så rapporten viser hvad der faktisk ville ske.
//   • Hver rettelse har en FORVENTET nuværende værdi. Passer den ikke — fordi
//     nogen allerede har rettet den i CRM — springes rækken over i stedet for
//     at blive overskrevet.
//   • Testrækker lukkes kun hvis de STADIG er tomme (0 bons, tråde,
//     aktiviteter, tilbud). Har de fået indhold, røres de ikke.
//   • Lukning er is_active = 0, ikke DELETE — samme konvention som resten af
//     huset, og til at fortryde.
//   • Invarianter: antal bons/tråde/aktiviteter uændret, og hver rettet adresse
//     kan findes igen af mail-routingen bagefter.
//
// ── BRUG ────────────────────────────────────────────────────────────────────
//   node --experimental-sqlite scripts/fix-bounced-emails.js
//   node --experimental-sqlite scripts/fix-bounced-emails.js --apply
// ============================================================
'use strict';
const path = require('path');
const fs   = require('fs');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
}
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');

const { getDb } = require('../db/database');
const { findCustomerByEmail } = require('../services/mailService');
const { mergeEntity } = require('./merge-april-import-duplicates');

const APPLY = process.argv.includes('--apply');

// ── Arbejdslisten. Bevidst data, ikke logik — den skal kunne læses og
//    efterprøves uden at læse resten af filen. ────────────────────────────────

const EMAIL_FIXES = [
    {
        customer_id: 3886, fra: 'hej@byenslndhandel.dk', til: 'hej@byenslandhandel.dk',
        hvorfor: 'domænet mangler et "a" — Rikke Pape står allerede i systemet med den rigtige',
    },
    {
        customer_id: 3276, fra: 'ajac0005@reigonh.dk', til: 'ajac0005@regionh.dk',
        hvorfor: 'ombyttede bogstaver i regionh — samme person findes to gange mere med den rigtige',
    },
    {
        customer_id: 4192, fra: 'kontoret@xn--nrrebro-lilleskole-g4b.dk', til: 'kontoret@norrebro-lilleskole.dk',
        hvorfor: 'punycode for nørrebro-lilleskole.dk, men skolen bruger norrebro uden ø — samme person står med den rigtige',
    },
];

// Sammenlægninger et menneske har bekræftet. Scriptets egne vagter ville have
// afvist begge — derfor står de her, med navns nævnelse, og ikke som en regel.
const CONFIRMED_MERGES = [
    {
        loser: 3276, winner: 3553,
        hvorfor: 'Alice Jacobsen står to gange på Bispebjerg — samme person (bekræftet af Leif)',
    },
    {
        loser: 4192, winner: 3149,
        hvorfor: '"Vetch" er en stavefejl for "Veitch" — samme person (bekræftet af Leif)',
    },
];

const TEST_ROWS = [
    { customer_id: 3981, company_id: null, hvorfor: 'test@test.com · "test af"' },
    { customer_id: 3318, company_id: 4006, hvorfor: 'firma hedder "Test" · bekræftet af Leif' },
    { customer_id: 3676, company_id: 3066, hvorfor: 'firma hedder "test" · bekræftet af Leif' },
];

// #2965 Nils Meinhard (firma "Testing") er IKKE med. Den lignede testdata, men
// navn og adresse ser ægte ud, og den blev ikke bekræftet. Tag den med i hånden
// hvis den skal væk.
//
// #3314 PeakMonday er heller ikke med som firma: navnet ser ægte ud, selvom den
// eneste kunde under det er en testrække. Kunden lukkes, firmaet bliver stående.

function backupDb(db) {
    const dir = path.join(path.dirname(path.resolve(process.env.DB_PATH)), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');  // utc-ok: filnavn
    const dest = path.join(dir, `bon-foer-mailrettelser-${stamp}.db`);
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    return dest;
}

const navnPaa = (c) => `${c.first_name || ''} ${c.last_name || ''}`.replace(/\s+/g, ' ').trim();

/** Hvor meget hænger der på rækken? Bruges som værn før en testrække lukkes. */
function indhold(db, id) {
    const q = (sql) => db.prepare(sql).get(id).n;
    return {
        bons:       q('SELECT COUNT(*) n FROM bons WHERE customer_id = ?'),
        traade:     q('SELECT COUNT(*) n FROM mail_threads WHERE customer_id = ?'),
        aktiviteter:q('SELECT COUNT(*) n FROM crm_activities WHERE customer_id = ?'),
        tilbud:     q('SELECT COUNT(*) n FROM quotes WHERE customer_id = ?'),
    };
}

function rettAdresse(db, fix, rapport) {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(fix.customer_id);
    if (!c) { rapport.sprunget.push(`#${fix.customer_id} findes ikke`); return; }

    const nuvaerende = String(c.email || '').trim();
    if (nuvaerende.toLowerCase() !== fix.fra.toLowerCase()) {
        rapport.sprunget.push(
            `#${fix.customer_id} ${navnPaa(c)} — adressen er ikke længere "${fix.fra}" men "${nuvaerende}". Rettet i hånden? Springes over.`);
        return;
    }

    db.prepare('UPDATE customers SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(fix.til, c.id);

    // contact_points er den autoritative kilde — customers.email er cache.
    const cps = db.prepare(
        `SELECT id, value, is_active FROM contact_points
          WHERE entity_type = 'customer' AND entity_id = ? AND kind = 'email'`
    ).all(c.id);

    let cpRettet = 0, cpLukket = 0;
    // Findes måltalværdien allerede på kunden? (UNIQUE dækker også lukkede rækker.)
    const findes = cps.find(x => String(x.value).trim().toLowerCase() === fix.til.toLowerCase());
    for (const cp of cps) {
        if (String(cp.value).trim().toLowerCase() !== fix.fra.toLowerCase()) continue;
        if (findes) {
            db.prepare(`UPDATE contact_points SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(findes.id);
            db.prepare(`UPDATE contact_points SET is_active = 0, is_primary = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(cp.id);
            cpLukket++;
        } else {
            db.prepare(`UPDATE contact_points SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(fix.til, cp.id);
            cpRettet++;
        }
    }

    db.prepare(
        `INSERT INTO changelog (entity_type, entity_id, action, field_name, old_value, new_value, notes, payload)
         VALUES ('customer', ?, 'email_correction', 'email', ?, ?, ?, ?)`
    ).run(c.id, fix.fra, fix.til,
          'Adressen bouncede med "domænet findes ikke". ' + fix.hvorfor,
          JSON.stringify({ fra: fix.fra, til: fix.til, contact_points: { rettet: cpRettet, lukket: cpLukket } }));

    rapport.rettede.push({ id: c.id, navn: navnPaa(c), fra: fix.fra, til: fix.til, hvorfor: fix.hvorfor });
}

function lukTestraekke(db, t, rapport) {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(t.customer_id);
    if (!c) { rapport.sprunget.push(`#${t.customer_id} findes ikke`); return; }
    if (!c.is_active) { rapport.sprunget.push(`#${t.customer_id} ${navnPaa(c)} er allerede lukket`); return; }

    const i = indhold(db, c.id);
    const sum = i.bons + i.traade + i.aktiviteter + i.tilbud;
    if (sum > 0) {
        rapport.sprunget.push(
            `#${c.id} ${navnPaa(c)} — har fået indhold siden gennemgangen `
          + `(bons ${i.bons}, tråde ${i.traade}, aktiviteter ${i.aktiviteter}, tilbud ${i.tilbud}). Røres ikke.`);
        return;
    }

    db.prepare(
        `UPDATE customers SET is_active = 0, notes = COALESCE(notes,'') || ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run('\n[Testrække — lukket ved oprydning]', c.id);
    db.prepare(
        `UPDATE contact_points SET is_active = 0, is_primary = 0, updated_at = CURRENT_TIMESTAMP
          WHERE entity_type = 'customer' AND entity_id = ? AND is_active = 1`
    ).run(c.id);

    let firma = null;
    if (t.company_id) {
        const co = db.prepare('SELECT * FROM companies WHERE id = ? AND is_active = 1').get(t.company_id);
        const andre = co ? db.prepare('SELECT COUNT(*) n FROM customers WHERE company_id = ? AND is_active = 1').get(co.id).n : 0;
        const bons  = co ? db.prepare('SELECT COUNT(*) n FROM bons WHERE company_id = ?').get(co.id).n : 0;
        if (co && andre === 0 && bons === 0) {
            db.prepare(
                `UPDATE companies SET is_active = 0, notes = COALESCE(notes,'') || ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
            ).run('\n[Testfirma — lukket ved oprydning]', co.id);
            db.prepare(
                `UPDATE contact_points SET is_active = 0, is_primary = 0, updated_at = CURRENT_TIMESTAMP
                  WHERE entity_type = 'company' AND entity_id = ? AND is_active = 1`
            ).run(co.id);
            firma = { id: co.id, navn: String(co.name || '').replace(/\s+/g, ' ').trim() };
        } else if (co) {
            rapport.sprunget.push(`firma #${co.id} "${String(co.name).replace(/\s+/g,' ').trim()}" beholdes — ${andre} andre kunder, ${bons} bons`);
        }
    }

    db.prepare(
        `INSERT INTO changelog (entity_type, entity_id, action, field_name, notes, payload)
         VALUES ('customer', ?, 'test_data_closed', 'is_active', ?, ?)`
    ).run(c.id, 'Testrække lukket. ' + t.hvorfor, JSON.stringify({ email: c.email, firma }));

    rapport.lukkede.push({ id: c.id, navn: navnPaa(c), email: String(c.email || '').trim(), hvorfor: t.hvorfor, firma });
}

function laegSammen(db, m, rapport) {
    const loser  = db.prepare('SELECT * FROM customers WHERE id = ?').get(m.loser);
    const winner = db.prepare('SELECT * FROM customers WHERE id = ?').get(m.winner);
    if (!loser || !winner) { rapport.sprunget.push(`sammenlægning ${m.loser}→${m.winner}: en af rækkerne findes ikke`); return; }
    if (!loser.is_active)  { rapport.sprunget.push(`#${m.loser} er allerede lukket`); return; }
    if (!winner.is_active) { rapport.sprunget.push(`#${m.winner} er lukket — kan ikke være overlever`); return; }

    // Vagt: overleveren skal stadig være den med mest på sig. Er billedet
    // vendt siden gennemgangen, er forudsætningen for beslutningen skredet.
    const vaegt = (id) => db.prepare('SELECT (SELECT COUNT(*) FROM bons WHERE customer_id=?) + (SELECT COUNT(*) FROM mail_threads WHERE customer_id=?) n').get(id, id).n;
    const vl = vaegt(loser.id), vw = vaegt(winner.id);
    if (vl > vw) {
        rapport.sprunget.push(
            `sammenlægning #${loser.id}→#${winner.id} sprunget over: taberen har nu MERE på sig (${vl} vs ${vw}). Se på det i hånden.`);
        return;
    }

    mergeEntity(db, 'customer', loser, winner, m.hvorfor);
    rapport.sammenlagte.push({
        loser: loser.id, winner: winner.id, hvorfor: m.hvorfor,
        navn: navnPaa(winner), flyttet: vl,
    });
}

function tael(db) {
    const q = (sql) => db.prepare(sql).get().n;
    return {
        bons:        q('SELECT COUNT(*) n FROM bons'),
        traade:      q('SELECT COUNT(*) n FROM mail_threads'),
        aktiviteter: q('SELECT COUNT(*) n FROM crm_activities'),
    };
}

function main() {
    const db = getDb();
    console.log(`Database: ${path.resolve(process.env.DB_PATH)}`);
    console.log(APPLY ? 'Tilstand:  APPLY — der skrives\n' : 'Tilstand:  DRY-RUN — der skrives ikke (brug --apply)\n');

    const backup = APPLY ? backupDb(db) : null;
    if (backup) console.log(`Backup: ${backup}\n`);

    const foer = tael(db);
    const rapport = { rettede: [], sammenlagte: [], lukkede: [], sprunget: [], dubletter: [] };

    db.exec('BEGIN');
    try {
        for (const f of EMAIL_FIXES)      rettAdresse(db, f, rapport);
        for (const m of CONFIRMED_MERGES) laegSammen(db, m, rapport);
        for (const t of TEST_ROWS)        lukTestraekke(db, t, rapport);

        // Invariant 1: intet forretningsindhold må være forsvundet.
        const efter = tael(db);
        const fejl = [];
        for (const k of Object.keys(foer)) {
            if (foer[k] !== efter[k]) fejl.push(`${k}: ${foer[k]} → ${efter[k]}`);
        }

        // Invariant 2: hver rettet adresse skal kunne findes af mail-routingen.
        for (const r of rapport.rettede) {
            if (!findCustomerByEmail(db, r.til)) {
                fejl.push(`"${r.til}" kan ikke findes af mail-routingen efter rettelsen`);
                continue;
            }
            // Rækker der er lagt sammen umiddelbart efter, er lukkede nu og
            // deler ikke længere noget med nogen.
            const stadigAktiv = db.prepare('SELECT is_active FROM customers WHERE id = ?').get(r.id);
            if (!stadigAktiv || !stadigAktiv.is_active) continue;

            // Hvem ANDRE har adressen nu? Spørg direkte — findCustomerByEmail
            // bruger LIMIT 1 og kan lige så godt returnere den række vi netop
            // rettede, og så ville dubletten være usynlig i rapporten.
            const andre = db.prepare(
                `SELECT DISTINCT c.id FROM customers c
                  LEFT JOIN contact_points cp
                         ON cp.entity_type = 'customer' AND cp.entity_id = c.id
                        AND cp.kind = 'email' AND cp.is_active = 1
                  WHERE c.is_active = 1 AND c.id <> ?
                    AND (LOWER(TRIM(c.email)) = LOWER(?) OR LOWER(TRIM(cp.value)) = LOWER(?))`
            ).all(r.id, r.til, r.til).map(x => x.id);
            if (andre.length) rapport.dubletter.push({ ...r, tvillinger: andre });
        }

        if (fejl.length) throw new Error('Invarianter brudt:\n  - ' + fejl.join('\n  - '));

        if (APPLY) db.exec('COMMIT'); else db.exec('ROLLBACK');
    } catch (err) {
        db.exec('ROLLBACK');
        throw new Error(err.message + '\n  → Alt er rullet tilbage. Databasen er urørt.');
    }

    if (rapport.rettede.length) {
        console.log('ADRESSER RETTET:');
        for (const r of rapport.rettede) {
            console.log(`  #${r.id} ${r.navn}`);
            console.log(`     ${r.fra}  →  ${r.til}`);
            console.log(`     ${r.hvorfor}`);
        }
    }
    if (rapport.sammenlagte.length) {
        console.log('\nSAMMENLAGT (bekræftede beslutninger):');
        for (const s of rapport.sammenlagte) {
            console.log(`  #${s.loser} → #${s.winner} ${s.navn}`);
            console.log(`     ${s.hvorfor}`);
        }
    }
    if (rapport.lukkede.length) {
        console.log('\nTESTRÆKKER LUKKET:');
        for (const l of rapport.lukkede) {
            console.log(`  #${l.id} ${l.navn} <${l.email}> — ${l.hvorfor}`
                      + (l.firma ? `\n     + firma #${l.firma.id} "${l.firma.navn}"` : ''));
        }
    }
    if (rapport.sprunget.length) {
        console.log('\nSPRUNGET OVER:');
        for (const s of rapport.sprunget) console.log('  ' + s);
    }
    if (rapport.dubletter.length) {
        console.log('\nDELER NU ADRESSE MED EN ANDEN (forventet):');
        for (const d of rapport.dubletter) console.log(`  #${d.id} deler ${d.til} med ${d.tvillinger.map(x => '#' + x).join(', ')}`);
        console.log('  → To personer på samme arbejdsplads kan dele postkasse; det er ikke');
        console.log('    i sig selv en dublet. Er de alligevel samme person, samles de i');
        console.log('    merge-wizarden under CRM → Værktøjer — ingen af oprydningsscriptene');
        console.log('    gør det af sig selv.');
    }

    console.log(`\n${rapport.rettede.length} adresse(r) rettet · ${rapport.sammenlagte.length} sammenlagt · ${rapport.lukkede.length} testrække(r) lukket · ${rapport.sprunget.length} sprunget over`);
    console.log(APPLY
        ? `\n✓ Gennemført. Fortryd ved at lægge backuppen tilbage:\n  ${backup}`
        : '\nDRY-RUN — alt er rullet tilbage, databasen er urørt. Kør med --apply når listen ser rigtig ud.');

    if (APPLY) {
        console.log('\nIkke rørt, kræver et opkald:');
        console.log('  #2996 Lisbeth Møinichen · ma@lf.dk — postkassen findes ikke mere. 17 bons. Tlf 23244966');
        console.log('  #4017 Eline Østergaard · peo@danner.dk — samme. Brug en kollega (naf@/shs@/azm@danner.dk)');
        console.log('  #4151 Niels Jerl · info@nielsjerl.dk — adressen er RIGTIG, postkassen var fuld. Prøv igen');
        console.log('  #3910 Ida Devald · ida@danner.dl — ".dl" er en tastefejl, men den rigtige er et gæt. Tlf 30785873');
    }
}

try {
    main();
} catch (err) {
    console.error('\n✗ ' + err.message);
    process.exitCode = 1;
}
