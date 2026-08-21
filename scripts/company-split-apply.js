#!/usr/bin/env node
'use strict';
/**
 * scripts/company-split-apply.js
 * ────────────────────────────────────────────────────────────
 * Udfør opdelingen af et paraply-firma efter en GODKENDT plan.
 *
 * Planen laves med company-split-plan.js og udfyldes i hånden: ét e-conomic
 * kundenummer pr. e-mail-domæne. Her flyttes kontakterne og deres bons over på
 * det rigtige firma, så fremtidige fakturaer går til den rigtige afdeling.
 *
 * DRY-RUN SOM STANDARD. --apply skriver, og tager backup først.
 *
 *   node --experimental-sqlite scripts/company-split-apply.js --plan data/split-plan-2582.csv --company 2582
 *   node --experimental-sqlite scripts/company-split-apply.js --plan data/split-plan-2582.csv --company 2582 --apply
 *
 * Hvad der IKKE flyttes, med vilje: kontaktpunkter, påmindelser, RFM og events
 * hænger på moderorganisationen og bliver på paraply-rækken. Det er firmaets
 * egne data, ikke afdelingens.
 *
 * Bemærk: langt de fleste bons er typisk allerede fakturerede. Opdelingen retter
 * historikken og fremtiden — den ændrer intet ved fakturaer der er sendt.
 * ────────────────────────────────────────────────────────────
 */
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const DB_PATH = arg('--db', process.env.DB_PATH || 'data/bon.db');
const PLAN    = arg('--plan', '');
const FIRMA   = Number(arg('--company', ''));
const SKRIV   = argv.includes('--apply');
const BRUGER  = Number(arg('--user', '')) || null;

if (!PLAN || !Number.isInteger(FIRMA)) {
    console.error('Brug: --plan <fil> --company <id> [--apply]');
    process.exit(2);
}

function laesCsv(tekst) {
    const linjer = tekst.split(/\r?\n/).filter(l => l.trim());
    const head = linjer.shift().split(';').map(h => h.trim());
    return linjer.map(l => {
        // Planen skrives af os selv, så felterne har ingen indlejrede semikolon —
        // men navne kan være citerede, og de skrælles her.
        const celler = l.split(';').map(c => c.replace(/^"|"$/g, '').replace(/""/g, '"'));
        return Object.fromEntries(head.map((h, i) => [h, (celler[i] ?? '').trim()]));
    });
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-zæøå0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function bigrams(s) { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; }
function dice(a, b) {
    a = norm(a); b = norm(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const A = bigrams(a), B = bigrams(b);
    let f = 0, sa = 0, sb = 0;
    for (const v of A.values()) sa += v;
    for (const [g, v] of B) { sb += v; if (A.has(g)) f += Math.min(v, A.get(g)); }
    return sa + sb ? 2 * f / (sa + sb) : 0;
}

/**
 * Sammenlign kun det der ADSKILLER to afdelinger. Alle KU-navne indeholder
 * "Københavns Universitet", så en lighed på hele navnet gør hver afdeling til
 * mulig dublet af hver anden. Trækker man paraply-navnet fra, står "biologisk
 * institut" mod "plen" — og så betyder tallet noget.
 */
function saerpraeg(navn, paraplyNavn) {
    const fjern = new Set(norm(paraplyNavn).split(' ').filter(o => o.length >= 3));
    return norm(navn).split(' ').filter(o => !fjern.has(o)).join(' ');
}

const db = new DatabaseSync(DB_PATH);
const paraply = db.prepare('SELECT id, name, cvr, ean FROM companies WHERE id = ?').get(FIRMA);
if (!paraply) { console.error(`Firma ${FIRMA} findes ikke i ${DB_PATH}.`); process.exit(1); }

const plan = laesCsv(fs.readFileSync(PLAN, 'utf8'))
    .filter(r => /^\d+$/.test(r.godkendt_nr || ''));      // "-" og tomme lades i fred

console.log(`\nParaply: ${paraply.id} "${paraply.name}"`);
console.log(`Plan:    ${PLAN} — ${plan.length} domæne(r) med et godkendt kundenummer\n`);
if (!plan.length) { console.log('Intet at gøre. Udfyld godkendt_nr i planen først.'); process.exit(0); }

// ── Hvad ville der ske? Beregnes ens for dry-run og apply ─────────────
// Nøglen i planen er enten et DOMÆNE ("bio.ku.dk") eller en ENKELT adresse
// ("pw@sund.ku.dk"). Det sidste bruges når domænet er et fakultet — @sund.ku.dk
// deles af 13 institutter, så dér må hver person placeres for sig.
const DOMAENE_SQL = "lower(TRIM(replace(replace(substr(email, instr(email,'@')+1), char(10), ''), char(13), '')))";
const findPrDomaene = db.prepare(`SELECT id, first_name, last_name, email FROM customers
     WHERE company_id = ? AND ${DOMAENE_SQL} = ?`);
const findPrEmail = db.prepare(`SELECT id, first_name, last_name, email FROM customers
     WHERE company_id = ? AND lower(TRIM(email)) = ?`);
const findKunder = { all: (firma, nøgle) => nøgle.includes('@')
    ? findPrEmail.all(firma, nøgle) : findPrDomaene.all(firma, nøgle) };
const taelBons = db.prepare('SELECT COUNT(*) n FROM bons WHERE company_id = ? AND customer_id = ?');
const taelSendte = db.prepare(`SELECT COUNT(*) n FROM bons b JOIN status_definitions s ON s.id = b.status_id
     WHERE b.company_id = ? AND b.customer_id = ?
       AND (b.economic_draft_number IS NOT NULL OR s.code IN ('FAKTURERET','BETALT','AFSLUTTET'))`);

const trin = [];
let advarsler = 0;
for (const r of plan) {
    const nr = r.godkendt_nr;
    const kunder = findKunder.all(FIRMA, r.domaene);
    const bons = kunder.reduce((n, k) => n + taelBons.get(FIRMA, k.id).n, 0);
    const sendte = kunder.reduce((n, k) => n + taelSendte.get(FIRMA, k.id).n, 0);

    // Findes firmaet allerede? Så flyttes der IND i det — ellers laver vi netop
    // den slags dublet vi er ved at rydde op i.
    const maal = db.prepare('SELECT id, name FROM companies WHERE TRIM(economic_customer_id) = ?').get(nr);

    // Et firma med samme navn men et ANDET nummer er et faresignal: så findes
    // afdelingen allerede, koblet et andet sted hen.
    // Lighed på HELE navnet, ikke på en præfiks: alle KU-firmaer starter ens, så
    // et LIKE på de første tegn udpegede hver eneste af dem som mulig dublet.
    const ligner = db.prepare(`SELECT id, name, economic_customer_id FROM companies
         WHERE id <> ? AND TRIM(COALESCE(economic_customer_id,'')) <> ?`).all(FIRMA, nr)
        .map(c => ({ ...c, s: dice(saerpraeg(r.forslag_navn, paraply.name), saerpraeg(c.name, paraply.name)) }))
        .filter(c => c.s >= 0.6).sort((a, b) => b.s - a.s).slice(0, 3);

    // EAN arves KUN når det godkendte nummer er dét scriptet foreslog. Har et
    // menneske valgt en anden kunde, hører forslagets EAN til nogen helt anden.
    // Tomt er sikkert: modtagerens EAN kommer fra e-conomic ved fakturering.
    const ean = (nr === (r.forslag_nr || '')) ? r.forslag_ean : '';
    trin.push({ domaene: r.domaene, nr, navn: r.forslag_navn, ean, kunder, bons, sendte, maal, ligner });
    if (ligner.length) advarsler++;
}

for (const t of trin) {
    console.log(`  ${t.domaene.padEnd(16)} → e-conomic ${t.nr} "${t.navn}"`);
    const alleredePlanlagt = !t.maal && trin.some(a => a !== t && !a.maal && a.nr === t.nr && trin.indexOf(a) < trin.indexOf(t));
    console.log(`      ${t.maal ? `flyttes ind i eksisterende firma ${t.maal.id} "${t.maal.name}"`
        : alleredePlanlagt ? `flyttes ind i det firma en tidligere række opretter for ${t.nr}`
        : `NYT firma oprettes: "${t.navn}" (CVR ${paraply.cvr || '—'}, EAN ${t.ean || '—'})`}`);
    if (!t.kunder.length) console.log('      intet at flytte — kontakterne ligger ikke længere på paraply-rækken (allerede opdelt?)');
    else console.log(`      ${t.kunder.length} kontakt(er) · ${t.bons} bon(s)`
        + (t.sendte ? ` · heraf ${t.sendte} allerede faktureret (historik omfordeles, sendte fakturaer røres ikke)` : ''));
    for (const l of t.ligner) console.log(`      ⚠ ligner firma ${l.id} "${l.name}" (e-conomic ${l.economic_customer_id || 'ukoblet'}, lighed ${l.s.toFixed(2)}) — samme afdeling?`);
    console.log('');
}

const iAlt = trin.reduce((a, t) => ({ k: a.k + t.kunder.length, b: a.b + t.bons }), { k: 0, b: 0 });
const bliver = db.prepare('SELECT COUNT(*) n FROM bons WHERE company_id = ?').get(FIRMA).n - iAlt.b;
console.log(`I alt: ${iAlt.k} kontakter og ${iAlt.b} bons flyttes · ${bliver} bons bliver på "${paraply.name}"`);
if (advarsler) console.log(`⚠ ${advarsler} gruppe(r) ligner et firma der allerede findes — tjek dem før --apply.`);

if (!iAlt.k) {
    console.log('\nIntet at flytte. Enten er opdelingen allerede udført, eller også passer domænerne i planen ikke til firmaet.');
    db.close();
    process.exit(0);
}

if (!SKRIV) {
    console.log('\n── DRY-RUN. Intet er skrevet. Kør med --apply for at udføre. ──');
    console.log('   Kontaktpunkter, påmindelser, RFM og events bliver på paraply-rækken med vilje.');
    db.close();
    process.exit(0);
}

// ── Skrivning ────────────────────────────────────────────────────────
// Tidsstempel i navnet: VACUUM INTO nægter at overskrive, og en anden kørsel må
// ikke vælte på at den forrige backup stadig ligger der.
const backup = `${DB_PATH}.split-${FIRMA}-${Date.now()}.backup`;   // utc-ok: filnavn
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
console.log(`\nBackup: ${backup}`);

const logChange = db.prepare(`INSERT INTO changelog
    (entity_type, entity_id, action, field_name, old_value, new_value, user_id, notes)
    VALUES (?,?,?,?,?,?,?,?)`);
let oprettede = 0, flyttedeK = 0, flyttedeB = 0;
const oprettetNu = new Map();   // kundenr → firma-id, så to rækker deler ét firma
try {
    db.exec('BEGIN');
    for (const t of trin) {
        let maalId = t.maal?.id ?? oprettetNu.get(t.nr);
        if (!maalId) {
            maalId = db.prepare('INSERT INTO companies (name, cvr, ean, economic_customer_id) VALUES (?,?,?,?) RETURNING id')
                       .get(t.navn, paraply.cvr || null, t.ean || null, t.nr).id;
            oprettetNu.set(t.nr, maalId);
            oprettede++;
            logChange.run('company', maalId, 'create', null, null, t.navn, BRUGER,
                `Udskilt fra ${paraply.id} "${paraply.name}" — domæne ${t.domaene}`);
        }
        for (const k of t.kunder) {
            db.prepare('UPDATE customers SET company_id = ? WHERE id = ?').run(maalId, k.id);
            flyttedeK++;
            const n = db.prepare('UPDATE bons SET company_id = ? WHERE company_id = ? AND customer_id = ? RETURNING id')
                        .all(maalId, FIRMA, k.id).length;
            flyttedeB += n;
            logChange.run('customer', k.id, 'update', 'company_id', String(FIRMA), String(maalId), BRUGER,
                `Opdeling af paraply-firma: ${t.domaene} → e-conomic ${t.nr}` + (n ? ` (${n} bons fulgte med)` : ''));
        }
        logChange.run('company', FIRMA, 'update', 'split', null, String(maalId), BRUGER,
            `${t.kunder.length} kontakter og ${t.bons} bons flyttet til ${maalId} (${t.domaene})`);
    }
    db.exec('COMMIT');
} catch (e) {
    db.exec('ROLLBACK');
    console.error(`\n✗ Fejl — intet er ændret: ${e.message}`);
    console.error(`  Backup ligger i ${backup}`);
    process.exit(1);
}
console.log(`\n✓ Færdig: ${oprettede} nye firmaer · ${flyttedeK} kontakter · ${flyttedeB} bons flyttet`);
db.close();
