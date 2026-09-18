#!/usr/bin/env node
// scripts/audit-formidler-slutkunder.js
// ==========================================
// READ-ONLY. Hvilke bons ligger på en formidler (companies.is_reseller = 1),
// hvem er slutkunden — og HVOR kom navnet fra?
//
// Feltet `bons.end_customer_name` kan skrives fire steder, og de kræver hver
// sin opfølgning. Derfor er kilden rapportens egentlige indhold:
//
//   formular   Kunden tastede navnet i bestillingsformularens Firma-felt, og
//              resolveOrderCompany gemte det (services/orderCompanyResolver.js).
//              Ingen end_customer_name-linje i changelog; oprettelses-linjen
//              bærer "slutkunde: X". Dette er den normale vej.
//   backfill   scripts/backfill-able-end-customer.js — et menneske læste
//              fritekst på gamle bons og skrev en liste.
//   merge      scripts/merge-reseller-junk-companies.js — navnet er UDLEDT af
//              den skraldespands-firmarække bonnen lå på før migration 167.
//   <navn>     Et menneske tastede det i bon-draweren.
//
// Kilden bestemmes af den SENESTE end_customer_name-linje i changelog — det er
// den der satte den værdi der står i dag. Findes ingen, er det formularen.
//
// Rapporten slutter med navne-varianter: to stavemåder af samme slutkunde
// ("Systematic" og "Systematic / able") er to rækker i enhver liste og to
// søgninger for office. Det er dét der er værd at rydde op i.
//
// Brug:
//   node --experimental-sqlite scripts/audit-formidler-slutkunder.js
//   ... --company 3570      kun én formidler
//   ... --since 2026-01-01  kun bons leveret efter en dato
//   ... --csv ude.csv       hele listen til fil
// ==========================================

'use strict';

const fs = require('fs');
const { openDb } = require('../db/compat');
const { normalizeName } = require('../services/companyMatcher');

const args = process.argv.slice(2);
const argVal = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const DB_PATH = process.env.DB_PATH || './data/bon.db';
const ONLY_COMPANY = argVal('--company') ? parseInt(argVal('--company'), 10) : null;
const SINCE = argVal('--since');
const CSV = argVal('--csv');

const db = openDb(DB_PATH);

// ─── Formidlerne ─────────────────────────────────────────────
const resellers = db.prepare(`
    SELECT id, name FROM companies
    WHERE is_reseller = 1 ${ONLY_COMPANY ? 'AND id = ?' : ''}
    ORDER BY name
`).all(...(ONLY_COMPANY ? [ONLY_COMPANY] : []));

if (!resellers.length) {
    console.log(ONLY_COMPANY
        ? `Firma ${ONLY_COMPANY} findes ikke eller er ikke markeret som formidler.`
        : 'Ingen firmaer er markeret som formidler (companies.is_reseller = 1).');
    process.exit(0);
}

// ─── Kilde pr. bon ───────────────────────────────────────────
// Seneste end_customer_name-linje vinder. Scripterne skriver user_id NULL og
// kendes på deres notes-tekst; et menneske har et user_id.
const lastEdit = db.prepare(`
    SELECT ch.new_value, ch.notes, ch.created_at, ch.user_id, u.name AS hvem
    FROM changelog ch LEFT JOIN users u ON u.id = ch.user_id
    WHERE ch.entity_type = 'bon' AND ch.entity_id = ? AND ch.field_name = 'end_customer_name'
    ORDER BY ch.created_at DESC, ch.id DESC LIMIT 1
`);

function kilde(bonId) {
    const e = lastEdit.get(bonId);
    if (!e) return { kode: 'formular', tekst: 'formular' };
    if (e.user_id) return { kode: 'manuel', tekst: e.hvem || `bruger ${e.user_id}`, naar: e.created_at };
    const n = e.notes || '';
    if (n.includes('backfill-able-end-customer')) return { kode: 'backfill', tekst: 'backfill', naar: e.created_at };
    if (n.includes('udledt af firma-rækken')) return { kode: 'merge', tekst: 'merge (udledt)', naar: e.created_at };
    return { kode: 'ukendt', tekst: 'ukendt script', naar: e.created_at };
}

// ─── Navne-kerne, til at finde stavevarianter ────────────────
// "Systematic / able" og "Systematic" er samme slutkunde. Formidlerens eget
// navn hængt bagpå er en konvention hos dem, ikke en del af kundens navn.
//
// Derefter køres navnet gennem `normalizeName` fra services/companyMatcher.js
// — den SAMME normalisering matcheren bruger til at afgøre om to firmanavne
// er samme firma. Den fjerner parenteser og juridiske endelser (A/S, ApS,
// I/S, Holding, Group …), så "Systematic A/S" og "Systematic  (Able)" havner
// hos "Systematic". Uden den stod `Systematic A/S` som en selvstændig
// slutkunde i drift, og listen sagde 5 hvor den skulle sige 6.
//
// En AFDELINGS-tilføjelse er derimod ikke en endelse og grupperes ikke:
// "Per Aarsleff – Kontor i Lyngby" forbliver adskilt fra "Per Aarsleff",
// fordi forskellen kan være reel (anden adresse, anden afdeling). Det er et
// menneskes beslutning, ikke en normalisering.
function kerne(navn, formidler) {
    let s = String(navn || '').trim();
    const f = String(formidler || '').trim();
    if (f) {
        const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        s = s.replace(new RegExp(`[\\s]*[\\/\\-–—,(]+[\\s]*${esc}[\\s)]*$`, 'i'), '');
    }
    return normalizeName(s);
}

const csvRows = [['formidler', 'bon', 'leveringsdato', 'status', 'slutkunde', 'kilde', 'formular_skrev']];
let iAlt = 0, udenNavn = 0;
const kildeTal = {};

for (const r of resellers) {
    const bons = db.prepare(`
        SELECT b.id, b.bon_number, b.delivery_date, b.end_customer_name,
               sd.code AS status, w.company AS formular_skrev
        FROM bons b
        LEFT JOIN status_definitions sd ON sd.id = b.status_id
        LEFT JOIN web_orders w ON w.bon_id = b.id
        WHERE b.company_id = ? ${SINCE ? 'AND b.delivery_date >= ?' : ''}
        ORDER BY b.delivery_date DESC, b.bon_number DESC
    `).all(...(SINCE ? [r.id, SINCE] : [r.id]));

    const medNavn = bons.filter(b => (b.end_customer_name || '').trim());
    const uden    = bons.filter(b => !(b.end_customer_name || '').trim());
    udenNavn += uden.length;
    iAlt += medNavn.length;

    console.log(`\n${'═'.repeat(78)}`);
    console.log(`  ${r.name}  (firma #${r.id})`);
    console.log(`  ${bons.length} bons · ${medNavn.length} med slutkunde · ${bons.length - medNavn.length} uden`);
    console.log('═'.repeat(78));

    if (!medNavn.length) {
        console.log('  (ingen bons med slutkunde)');
        for (const b of uden)
            console.log('     ' + String(b.bon_number).padEnd(12) +
                        String(b.delivery_date || '—').padEnd(12) + (b.status || ''));
        continue;
    }

    console.log(`  ${'BON'.padEnd(11)}${'DATO'.padEnd(12)}${'STATUS'.padEnd(11)}${'SLUTKUNDE'.padEnd(27)}KILDE`);
    console.log('  ' + '─'.repeat(74));

    const grupper = new Map();
    for (const b of medNavn) {
        const navn = b.end_customer_name.trim();
        const k = kilde(b.id);
        kildeTal[k.kode] = (kildeTal[k.kode] || 0) + 1;

        // Afviger det gemte navn fra det formularen modtog, har nogen rettet det.
        const rettet = b.formular_skrev && b.formular_skrev.trim() !== navn;

        console.log('  ' +
            String(b.bon_number).padEnd(11) +
            String(b.delivery_date || '—').padEnd(12) +
            String(b.status || '—').padEnd(11) +
            (navn.length > 25 ? navn.slice(0, 24) + '…' : navn).padEnd(27) +
            k.tekst + (rettet ? `  ⚠ formularen sagde "${b.formular_skrev.trim()}"` : ''));

        const g = kerne(navn, r.name);
        if (!grupper.has(g)) grupper.set(g, new Map());
        grupper.get(g).set(navn, (grupper.get(g).get(navn) || 0) + 1);
        csvRows.push([r.name, b.bon_number, b.delivery_date || '', b.status || '',
                      navn, k.tekst, b.formular_skrev || '']);
    }

    // Stavevarianter — det der giver to rækker i listen for én slutkunde.
    const varianter = [...grupper.entries()].filter(([, navne]) => navne.size > 1);
    if (varianter.length) {
        console.log(`\n  ⚠ Samme slutkunde stavet forskelligt:`);
        for (const [, navne] of varianter) {
            const dele = [...navne.entries()].map(([n, c]) => `"${n}" ×${c}`).join('  ·  ');
            console.log(`     ${dele}`);
        }
    }

    // Bons uden slutkunde. IKKE en mangelliste: nogle formidlere oplyser aldrig
    // hvem maden er til, og et tomt felt er da det rigtige. Listen er her fordi
    // oplysningen typisk kommer i en mail EFTER bestillingen, og så skal man
    // kunne se hvilke bons der stadig kan udfyldes.
    if (uden.length) {
        console.log(`\n  ${uden.length} uden slutkunde:`);
        for (const b of uden)
            console.log('     ' + String(b.bon_number).padEnd(12) +
                        String(b.delivery_date || '—').padEnd(12) + (b.status || ''));
    }

    // Hvem er de, og hvor meget fylder de?
    const top = [...grupper.entries()]
        .map(([, navne]) => {
            const alle = [...navne.entries()];
            const antal = alle.reduce((s, [, c]) => s + c, 0);
            return { navn: alle.sort((a, b) => b[1] - a[1])[0][0], antal };
        })
        .sort((a, b) => b.antal - a.antal);
    console.log(`\n  ${top.length} forskellige slutkunder:`);
    console.log('     ' + top.map(t => `${t.navn} (${t.antal})`).join(' · '));
}

console.log(`\n${'═'.repeat(78)}`);
console.log(`  I alt: ${iAlt} bons med slutkunde · ${udenNavn} bons på en formidler uden`);
const label = { formular: 'fra bestillingsformularen', backfill: 'backfill-script',
                merge: 'merge-script (udledt af firmanavn)', manuel: 'tastet i hånden',
                ukendt: 'ukendt script' };
for (const [k, n] of Object.entries(kildeTal).sort((a, b) => b[1] - a[1]))
    console.log(`     ${String(n).padStart(4)}  ${label[k] || k}`);
console.log('═'.repeat(78));

if (CSV) {
    const esc = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    fs.writeFileSync(CSV, csvRows.map(r => r.map(esc).join(',')).join('\n') + '\n');
    console.log(`\nSkrevet: ${CSV}  (${csvRows.length - 1} rækker)`);
}

db.close();
