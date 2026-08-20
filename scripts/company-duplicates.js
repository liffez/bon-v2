#!/usr/bin/env node
'use strict';
/**
 * scripts/company-duplicates.js
 * ────────────────────────────────────────────────────────────
 * READ-ONLY: find dublet-firmaer inden for én familie.
 *
 * "Københavns Universitet" findes som 47 rækker i Bon: én paraply plus spredte
 * institut-rækker, hvoraf flere er dubletter af hinanden ("Institut for
 * matematiske fag, KU" · "Ku Math" · "Københavns Universitet - Institut for
 * Matematiske Fag"). Skal en paraply deles op, bør dubletterne lægges sammen
 * FØRST — ellers flytter man bons ind i endnu en ny række ved siden af dem.
 *
 * Klyngerne dannes på det der ADSKILLER navnene: familienavnet trækkes fra, så
 * "matematiske fag" står mod "math" i stedet for at alle ligner hinanden 90 %.
 *
 *   node --experimental-sqlite scripts/company-duplicates.js --familie "Københavns Universitet"
 *   node --experimental-sqlite scripts/company-duplicates.js --company 2582
 *
 *   --familie <navn>  familienavn (bruges både som filter og som det der trækkes fra)
 *   --company <id>    som ovenfor, men navnet hentes fra firmaet
 *   --alle            vis også klynger med kun én række
 * ────────────────────────────────────────────────────────────
 */
require('dotenv').config({ quiet: true });
const { DatabaseSync } = require('node:sqlite');

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const DB_PATH = arg('--db', process.env.DB_PATH || 'data/bon.db');
const FIRMA   = Number(arg('--company', ''));
const ALLE    = argv.includes('--alle');
const SWEEP   = argv.includes('--sweep');
const CVR     = String(arg('--cvr', '')).replace(/\D/g, '');
let FAMILIE   = arg('--familie', '');

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

const STRUKTUR = new Set(['institut', 'institute', 'center', 'centre', 'centret', 'afdeling',
    'afd', 'department', 'dept', 'sektion', 'section', 'for', 'och', 'the', 'of', 'and',
    'fakultet', 'faculty', 'skole', 'school', 'universitetshospitalet', 'union', 'forening']);

const db = new DatabaseSync(`file:${DB_PATH}?mode=ro`, { readOnly: true });
if (Number.isInteger(FIRMA) && !FAMILIE && !CVR) {
    FAMILIE = db.prepare('SELECT name FROM companies WHERE id = ?').get(FIRMA)?.name || '';
}
if (!FAMILIE && !CVR && !SWEEP) {
    console.error('Brug: --sweep  ·  --cvr <nummer>  ·  --familie "<navn>"  ·  --company <id>');
    process.exit(2);
}

if (SWEEP) {
    // Delt CVR er det eneste objektive familie-signal. For kommunerne er det også
    // det ENESTE brugbare: rækkerne hedder "Skolen på Grundtvigsvej" og "Fritidscenter
    // Christianshavn" — der er intet fælles ord at gruppere på. Navnet på moder-
    // organisationen udledes af det hyppigste ordpar blandt rækkerne.
    const familier = db.prepare(`
        SELECT TRIM(cvr) AS cvr, COUNT(*) AS raekker,
               SUM((SELECT COUNT(*) FROM bons b WHERE b.company_id = c.id)) AS bons,
               SUM(CASE WHEN COALESCE(TRIM(c.economic_customer_id),'') <> '' THEN 1 ELSE 0 END) AS koblede,
               SUM(CASE WHEN COALESCE(TRIM(c.economic_customer_id),'') = ''
                        THEN (SELECT COUNT(*) FROM bons b WHERE b.company_id = c.id) ELSE 0 END) AS ukoblede_bons
        FROM companies c WHERE COALESCE(TRIM(cvr),'') <> ''
        GROUP BY TRIM(cvr) HAVING COUNT(*) >= 3
    `).all();
    const navnePr = db.prepare("SELECT TRIM(cvr) AS cvr, name FROM companies WHERE COALESCE(TRIM(cvr),'') <> ''").all();
    const størsteNavn = new Map(db.prepare(`
        SELECT TRIM(cvr) AS cvr, name FROM companies c
         WHERE COALESCE(TRIM(cvr),'') <> ''
           AND (SELECT COUNT(*) FROM bons b WHERE b.company_id = c.id) =
               (SELECT MAX((SELECT COUNT(*) FROM bons b2 WHERE b2.company_id = c2.id))
                  FROM companies c2 WHERE TRIM(c2.cvr) = TRIM(c.cvr))
         GROUP BY TRIM(cvr)`).all().map(r => [r.cvr, r.name]));
    const navnFor = new Map();
    for (const n of navnePr) { const l = navnFor.get(n.cvr) || []; l.push(n.name); navnFor.set(n.cvr, l); }
    /** Hyppigste ordpar blandt familiens navne — "københavns kommune", "region hovedstaden". */
    const fællesNavn = (cvr) => {
        const tæl = new Map();
        for (const n of navnFor.get(cvr) || []) {
            // Strukturord ud: ellers bliver familien til "afdeling for" og "lær for".
            const o = norm(n).split(' ').filter(x => x.length >= 3 && !STRUKTUR.has(x));
            for (let i = 0; i < o.length - 1; i++) { const par = o[i] + ' ' + o[i + 1]; tæl.set(par, (tæl.get(par) || 0) + 1); }
        }
        const top = [...tæl.entries()].sort((a, b) => b[1] - a[1])[0];
        if (top && top[1] >= 2) return top[0];
        // Intet fælles ordpar — så er navnet på den travleste række mere sigende
        // end "(blandet)". Det gælder fx Arkitektforeningen, hvor rækkerne hedder
        // noget forskelligt hver især.
        return (størsteNavn.get(cvr) || '(blandet)').slice(0, 34);
    };
    db.close();
    familier.sort((a, b) => b.ukoblede_bons - a.ukoblede_bons || b.raekker - a.raekker);
    console.log(`\n${familier.length} familier med 3+ firma-rækker der deler CVR\n`);
    console.log('  CVR       rækker  bons  koblet  ukoblede bons   familie');
    for (const f of familier) {
        console.log(`  ${f.cvr}  ${String(f.raekker).padStart(6)}  ${String(f.bons).padStart(4)}  ${String(f.koblede).padStart(6)}  ${String(f.ukoblede_bons).padStart(13)}   ${fællesNavn(f.cvr)}`);
    }
    console.log('\nSorteret efter bons på UKOBLEDE rækker — dét er arbejdet der venter.');
    console.log('Gå i dybden med:  node --experimental-sqlite scripts/company-duplicates.js --cvr <nummer>\n');
    process.exit(0);
}

// Familien: rækker der deler et kendeord med familienavnet. Forkortelser fanges
// af det korte led ("ku"), som ellers rammer for bredt alene — derfor kræves
// ordgrænse, så "kursuslex" og "skulptur" ikke slipper med.
const ord = norm(FAMILIE).split(' ').filter(o => o.length >= 2);
// Kun det MEST karakteristiske ord — "københavns" deles med Københavns Kommune,
// "universitet" gør ikke. Plus forkortelsen dannet af forbogstaverne ("ku"), som
// fanger "KU Science" og "ku bio"; den kræver ordgrænse, ellers rammer den
// "Kursuslex" og "skulptur".
const kendeord = ord.filter(o => o.length >= 5).sort((a, b) => b.length - a.length)[0] || '';
const initialer = ord.filter(o => o.length >= 3).map(o => o[0]).join('');
if (!CVR && !kendeord && !initialer) { console.error('Familienavnet er for kort til at gruppere på. Brug --cvr.'); process.exit(2); }
const alle = db.prepare(`
    SELECT id, name, cvr, ean, economic_customer_id AS nr,
           (SELECT COUNT(*) FROM customers c WHERE c.company_id = companies.id) AS kontakter,
           (SELECT COUNT(*) FROM bons b WHERE b.company_id = companies.id) AS bons,
           (SELECT MAX(b.delivery_date) FROM bons b WHERE b.company_id = companies.id) AS seneste
    FROM companies
`).all();
db.close();

// Med --cvr er familien objektiv: alle rækker der deler nummeret. Det er den
// eneste vej for kommunerne, hvor rækkerne hedder "Skolen på Grundtvigsvej" og
// "Fritidscenter Christianshavn" — der er intet fælles ord at gruppere på.
const iFamilien = CVR
    ? alle.filter(c => String(c.cvr || '').replace(/\D/g, '') === CVR)
    : alle.filter(c => {
        const n = ' ' + norm(c.name) + ' ';
        if (kendeord && n.includes(kendeord)) return true;
        return initialer.length >= 2 && n.includes(' ' + initialer + ' ');
    });

// Uden et familienavn udledes det af rækkerne selv: de ord der går igen i mindst
// 60 % af navnene, er fællesdelen og skal trækkes fra før sammenligningen.
if (CVR && !FAMILIE) {
    const tæl = new Map();
    for (const c of iFamilien) for (const o of new Set(norm(c.name).split(' ').filter(x => x.length >= 3)))
        tæl.set(o, (tæl.get(o) || 0) + 1);
    // 30 %, ikke 60: kun godt halvdelen af Københavns Kommunes rækker har ordet
    // "kommune" i navnet, og uden at trække det fra kædes 20 forvaltninger sammen
    // til én klynge. Mindst 3 forekomster, så et lille navn ikke udhules.
    const fælles = [...tæl.entries()]
        .filter(([, n]) => n >= 3 && n >= iFamilien.length * 0.3).map(([o]) => o);
    FAMILIE = fælles.join(' ');
    console.log(`\nCVR ${CVR}: ${iFamilien.length} rækker`
        + (fælles.length ? ` · fælles i navnene: "${FAMILIE}"` : ' · rækkerne har intet navn til fælles'));
}

/** Det der ADSKILLER: familienavnets ord trækkes fra begge sider før sammenligning. */
const fjern = new Set([...norm(FAMILIE).split(' ').filter(Boolean), initialer]);
const saerpraeg = (navn) => norm(navn).split(' ').filter(o => !fjern.has(o)).join(' ');

// Grådig klyngedannelse. Rækker uden særpræg (rene familienavne som "Københavns
// universitet") samles for sig — de er paraply-rækker, ikke institut-dubletter.
// Ord der findes i næsten alle afdelingsnavne. Uden dem kæder stamme-reglen 25
// institutter sammen, fordi de alle hedder "Institut for ...". Kun det der
// ADSKILLER må danne klynge.


const klynger = [];
const paraplyer = [];
for (const c of iFamilien.slice().sort((a, b) => b.bons - a.bons)) {
    const s = saerpraeg(c.name);
    if (!s) { paraplyer.push(c); continue; }
    // Kort form mod lang form ("math" ⊂ "matematiske fag", "bio" ⊂ "biologisk
    // institut") har lav dice-lighed, men er åbenlyst samme afdeling. Derfor
    // tælles det også som træf når et ord i den ene er stamme i et ord i den anden.
    // Stamme-reglen findes for FORKORTELSER: "math" ⊂ "matematiske", "bio" ⊂
    // "biologisk". Den må ikke gælde mellem to lange navne — dér kæder danske
    // sammensatte ord alt sammen ("børne" er stamme i både "børnefortællingen"
    // og "børne- og ungdomsforvaltningen", som er to forskellige enheder).
    // Derfor kun når mindst den ene side er kort nok til at være en forkortelse.
    const stamme = (a, b) => {
        const oa = a.split(' ').filter(x => x.length >= 3 && !STRUKTUR.has(x));
        const ob = b.split(' ').filter(y => y.length >= 3 && !STRUKTUR.has(y));
        if (oa.length > 2 && ob.length > 2) return false;
        return oa.some(x => ob.some(y => y.startsWith(x) || x.startsWith(y)));
    };
    const træf = klynger.find(k => dice(k.noegle, s) >= 0.72 || stamme(k.noegle, s));
    if (træf) træf.med.push({ ...c, s });
    else klynger.push({ noegle: s, med: [{ ...c, s }] });
}

const vis = klynger.filter(k => ALLE || k.med.length > 1)
    .sort((a, b) => b.med.reduce((n, c) => n + c.bons, 0) - a.med.reduce((n, c) => n + c.bons, 0));

console.log(`\nFamilie: ${iFamilien.length} firma-rækker i Bon`);
console.log(`${paraplyer.length} paraply-række(r) · ${klynger.length} navngivne grupper · ${vis.length} med mere end én række\n`);

if (paraplyer.length) {
    console.log('── Paraply-rækker (bærer selve familienavnet) ──');
    for (const p of paraplyer) console.log(`   ${String(p.id).padStart(4)}  ${String(p.name).slice(0, 46).padEnd(48)} ${String(p.bons).padStart(3)} bons · ${p.kontakter} kontakter · e-conomic ${p.nr || '—'}`);
    console.log('');
}

for (const k of vis) {
    const total = k.med.reduce((n, c) => n + c.bons, 0);
    // Store klynger er næsten altid over-flettede: danske sammensatte ord binder
    // navne sammen som ikke hører sammen ("børn" findes i både Børnefortællingen
    // og Børne- og Ungdomsforvaltningen — to forskellige enheder). Sig det, frem
    // for at lade tallet se ud som en konklusion.
    const mistanke = k.med.length >= 6;
    // Forslag til hvem der skal overleve: den med et e-conomic-nummer, ellers
    // den med flest bons. Sammenlægning bevarer historik uanset retning, men
    // en allerede koblet række sparer et ekstra opslag.
    const beholdes = k.med.slice().sort((a, b) => (b.nr ? 1 : 0) - (a.nr ? 1 : 0) || b.bons - a.bons)[0];
    console.log(`── "${k.noegle}" — ${k.med.length} rækker · ${total} bons`
        + (mistanke ? '   ⚠ stor klynge — sandsynligvis flere enheder blandet sammen' : ''));
    for (const c of k.med.sort((a, b) => b.bons - a.bons)) {
        const mærke = c.id === beholdes.id ? '←  behold' : '   læg ind i ' + beholdes.id;
        const ean = String(c.ean || '').trim();
        const eanNote = ean && !/^\d{13}$/.test(ean) ? `  ⚠ EAN "${ean}" er ikke 13 cifre` : '';
        console.log(`   ${String(c.id).padStart(4)}  ${String(c.name).slice(0, 44).padEnd(46)} ${String(c.bons).padStart(3)} bons · ${String(c.kontakter).padStart(2)} kont. · e-conomic ${String(c.nr || '—').padEnd(5)} ${mærke}${eanNote}`);
    }
    console.log('');
}

console.log('Klyngerne er FORSLAG, ikke konklusioner. Navnene grupperes på ordlighed, og');
console.log('danske sammensatte ord binder ting sammen der ikke hører sammen — "børn" står');
console.log('i både Børnefortællingen og Børne- og Ungdomsforvaltningen. Store klynger er');
console.log('markeret, men læs hver enkelt igennem: rækkerne står med fulde navne netop');
console.log('for at du kan se hvad der ikke passer.\n');
console.log('Sammenlægning gøres i CRM → Værktøjer → Sammenlæg firmaer (den flytter kunder,');
console.log('bons og kontaktinfo med). Læg dubletterne sammen FØR en paraply deles op —');
console.log('ellers flyttes bons ind i endnu en ny række ved siden af dem der findes.');
