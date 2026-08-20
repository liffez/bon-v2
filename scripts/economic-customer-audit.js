#!/usr/bin/env node
'use strict';
/**
 * scripts/economic-customer-audit.js
 * ────────────────────────────────────────────────────────────
 * READ-ONLY: er vores kunde-stamdata til at fakturere på?
 *
 * Baggrund: en faktura til den forkerte kunde er den dyreste fejl faktureringen
 * kan lave, og den opdages sjældent af sig selv. Tre uafhængige ting kan gøre den
 * mulig, og de tjekkes hver for sig:
 *
 *   1. KOBLINGEN   companies.economic_customer_id peger på en e-conomic-kunde.
 *                  Er det den rigtige? Navn, CVR og EAN skal passe. Et EAN der
 *                  ikke passer betyder at en offentlig faktura leveres et andet
 *                  sted — beløbet er rigtigt, modtageren er ikke.
 *   2. CVR         Bons CVR-numre kommer bl.a. fra fuzzy navnesøgning i Virk og
 *                  kan pege på en HELT anden — eller ophørt — virksomhed.
 *   3. STAMDATA    Samme berigelse har fyldt rå enum-værdier og datoserier i
 *                  employee_count.
 *
 * Skriver ALDRIG. Kan køres mod drift.
 *
 *   node --experimental-sqlite scripts/economic-customer-audit.js
 *   node --experimental-sqlite scripts/economic-customer-audit.js --db data/bon.db --cvr
 *
 *   --db <sti>  database (default: DB_PATH fra .env, ellers data/bon.db)
 *   --cvr       slå ALLE CVR-numre op i Virk (langsomt; uden flaget springes del 2 over)
 *   --alle      vis også rækker uden bons det seneste år
 * ────────────────────────────────────────────────────────────
 */
require('dotenv').config({ quiet: true });
const { DatabaseSync } = require('node:sqlite');
const eco = require('../services/economicAdapter');

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const DB_PATH  = arg('--db', process.env.DB_PATH || 'data/bon.db');
const MED_CVR  = argv.includes('--cvr');
const ALLE     = argv.includes('--alle');

const cif = (s) => String(s || '').replace(/\D/g, '');

/**
 * EAN-13 har et kontrolciffer, så en tastefejl kan påvises — ikke bare mistænkes.
 * Da Bon og e-conomic var uenige om Rigshospitalet -Neurocenters EAN, var det
 * dette der afgjorde hvem der havde ret: de to numre skiltes ved ét ciffer, og
 * kun det ene gik op. Uden tjekket kan man kun gætte på hvilken side der fejler.
 */
function eanGyldig(ean) {
    const e = cif(ean);
    if (e.length !== 13) return null;                       // ikke et EAN-13 — intet at sige
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(e[i]) * (i % 2 === 0 ? 1 : 3);
    return (10 - sum % 10) % 10 === Number(e[12]);
}
const LEGAL = /\b(a\/s|aps|ivs|i\/s|p\/s|k\/s|amba|holding|fonden|danmark|denmark|afd|afdeling)\b/gi;
const norm = (s) => String(s || '').toLowerCase().replace(LEGAL, '').replace(/[^a-zæøå0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function bigrams(s) { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; }
function dice(a, b) {
    a = norm(a); b = norm(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const A = bigrams(a), B = bigrams(b);
    let fælles = 0, sa = 0, sb = 0;
    for (const v of A.values()) sa += v;
    for (const [g, v] of B) { sb += v; if (A.has(g)) fælles += Math.min(v, A.get(g)); }
    return sa + sb ? 2 * fælles / (sa + sb) : 0;
}

/** Slå CVR-numre op i Virk ElasticSearch, i klumper. Tomt svar hvis nøgler mangler. */
async function virkVedCvr(numre) {
    const USER = process.env.VIRK_ES_USER, PASS = process.env.VIRK_ES_PASS;
    if (!USER || !PASS) return null;
    const ud = new Map();
    for (let i = 0; i < numre.length; i += 100) {
        const klump = numre.slice(i, i + 100);
        const res = await fetch('http://distribution.virk.dk/cvr-permanent/_search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') },
            body: JSON.stringify({ query: { terms: { 'Vrvirksomhed.cvrNummer': klump.map(Number) } }, size: klump.length }),
        });
        if (!res.ok) throw new Error(`Virk svarede HTTP ${res.status}`);
        for (const hit of (await res.json())?.hits?.hits || []) {
            const v = hit._source?.Vrvirksomhed; if (!v) continue;
            const meta = v.virksomhedMetadata || {};
            ud.set(String(v.cvrNummer), { navn: meta.nyesteNavn?.navn || '', status: meta.sammensatStatus || '' });
        }
        process.stderr.write(`\r  Virk: ${Math.min(i + 100, numre.length)}/${numre.length}   `);
    }
    process.stderr.write('\r' + ' '.repeat(40) + '\r\n');
    return ud;
}

const fund = { kritisk: [], advarsel: [], data: [] };
const meld = (niveau, bons, navn, tekst) => fund[niveau].push({ bons, navn, tekst });

(async () => {
    const db = new DatabaseSync(`file:${DB_PATH}?mode=ro`, { readOnly: true });
    const firmaer = db.prepare(`
        SELECT c.id, c.name, c.cvr, c.ean, c.economic_customer_id AS nr, c.employee_count,
               (SELECT COUNT(*) FROM bons b WHERE b.company_id = c.id
                  AND b.delivery_date >= date('now','-1 year')) AS bons
        FROM companies c
    `).all();
    db.close();
    const aktiv = (f) => ALLE || f.bons > 0;

    // ── 1. Koblingen: peger den på den rigtige kunde? ──────────────────
    const koblede = firmaer.filter(f => String(f.nr || '').trim() !== '');
    if (!eco.isConfigured()) {
        console.log('⚠ e-conomic er ikke konfigureret — koblings-tjekket springes over.\n');
    } else {
        let kunder = [], skip = 0;
        while (true) {
            const r = await eco.rest('/customers?pagesize=100&skippages=' + skip);
            kunder = kunder.concat(r.collection || []);
            if (!r.pagination?.nextPage || ++skip > 30) break;
        }
        const vedNr = new Map(kunder.map(k => [String(k.customerNumber), k]));

        /**
         * Findes der en e-conomic-kunde der passer BEDRE end den vi er koblet til?
         * Uden det siger rapporten kun "det her ser forkert ud" og lader én lede
         * manuelt — og så overser man at 735 "Rigshospitalet - Neurocenter" står
         * lige der, mens koblingen peger på bipolar-gruppen.
         */
        const forslag = (f, nuværende) => {
            const bedre = kunder
                .map(k => ({ k, s: dice(f.name, k.name) }))
                .filter(x => x.k.customerNumber !== nuværende?.customerNumber && x.s >= 0.75)
                .sort((a, b) => b.s - a.s).slice(0, 3);
            if (!bedre.length) return '';
            return `\n              mente du: ` + bedre.map(x =>
                `${x.k.customerNumber} "${String(x.k.name).slice(0, 40)}"${cif(x.k.ean) ? ` EAN ${cif(x.k.ean)}` : ''}`).join(' · ');
        };
        console.log(`e-conomic: ${kunder.length} kunder · Bon: ${firmaer.length} firmaer (${koblede.length} koblede)\n`);

        for (const f of koblede) {
            const k = vedNr.get(String(f.nr));
            if (!k) { meld('kritisk', f.bons, f.name, `koblet til kundenr ${f.nr}, som ikke findes i e-conomic`); continue; }
            if (k.barred) meld('kritisk', f.bons, f.name, `koblet til ${f.nr} "${k.name}", som er SPÆRRET i e-conomic`);

            // EAN styrer hvor en offentlig faktura leveres. Er de uenige, går den
            // et andet sted hen — med det rigtige beløb og den forkerte modtager.
            const a = cif(f.ean), b = cif(k.ean);
            if (a && b && a !== b) {
                // Kontrolcifferet afgør ofte striden uden at nogen skal gætte.
                const dom = eanGyldig(a) === false ? ' — BONS er ugyldigt (tastefejl), e-conomics ser rigtigt ud'
                          : eanGyldig(b) === false ? ' — E-CONOMICS er ugyldigt (tastefejl), Bons ser rigtigt ud'
                          : ' — begge er gyldige EAN, så det er to forskellige modtagere';
                meld('kritisk', f.bons, f.name, `EAN ${a} ≠ e-conomic ${f.nr} "${k.name}" EAN ${b}${dom}` + forslag(f, k));
            }
            else if (a && !b)      meld('advarsel', f.bons, f.name, `har EAN ${a}, men e-conomic ${f.nr} "${k.name}" har intet — e-faktura kan ikke leveres`);

            const ca = cif(f.cvr), cb = cif(k.corporateIdentificationNumber);
            if (ca && cb && ca !== cb) meld('advarsel', f.bons, f.name, `CVR ${ca} ≠ e-conomic ${f.nr} "${k.name}" CVR ${cb}`);

            // Navnet er det svageste signal (forkortelser: ATV = Akademiet for de
            // Tekniske Videnskaber), så det melder kun når intet andet holder dem sammen.
            const lighed = dice(f.name, k.name);
            if (lighed < 0.35 && !(ca && cb && ca === cb) && !(a && b && a === b))
                meld('advarsel', f.bons, f.name, `navnet ligner ikke e-conomic ${f.nr} "${k.name}" (lighed ${lighed.toFixed(2)}) og hverken CVR eller EAN binder dem sammen`
                    + forslag(f, k));
        }
    }

    // ── 1b. EAN: er nummeret overhovedet gyldigt? ─────────────────────
    for (const f of firmaer) {
        const e = cif(f.ean);
        if (!e) continue;
        if (e.length !== 13) { meld('advarsel', f.bons, f.name, `EAN ${e} er ${e.length} cifre — et EAN-13 har 13`); continue; }
        if (eanGyldig(e) === false) meld('kritisk', f.bons, f.name, `EAN ${e} har et ugyldigt kontrolciffer — tastefejl, e-fakturaen kan ikke leveres`);
    }

    // ── 2. CVR: peger nummeret på den virksomhed vi tror? ──────────────
    const medCvr = firmaer.filter(f => cif(f.cvr).length === 8);
    if (!MED_CVR) {
        console.log(`(${medCvr.length} firmaer har et CVR — kør med --cvr for at slå dem op i Virk)\n`);
    } else {
        const virk = await virkVedCvr([...new Set(medCvr.map(f => cif(f.cvr)))]);
        if (!virk) console.log('⚠ VIRK_ES_USER/VIRK_ES_PASS mangler — CVR-tjekket springes over.\n');
        else {
            // Paraply-CVR: hospitalsafdelinger, universitetsinstitutter og skoler har
            // ikke deres eget CVR — de bruger regionens, universitetets eller kommunens.
            // Deler tre eller flere firmaer samme nummer, er et navn der "ikke passer"
            // altså det NORMALE, ikke en fejl. Udledt af dataene, ikke en hardcodet liste.
            const brug = new Map();
            for (const f of medCvr) brug.set(cif(f.cvr), (brug.get(cif(f.cvr)) || 0) + 1);
            const paraplyer = new Map();   // CVR → antal afdelinger. Opsummeres, listes ikke.

            for (const f of medCvr) {
                const nr = cif(f.cvr);
                const v = virk.get(nr);
                if (!v) { meld('advarsel', f.bons, f.name, `CVR ${f.cvr} findes ikke i CVR-registret`); continue; }

                // En ophørt virksomhed kan ikke være kunde — uanset hvor godt navnet
                // passer. Det var netop dét der ramte Danner: navnet stemte perfekt,
                // men virksomheden blev opløst i 2013.
                if (/ophør|opløst|konkurs|tvangsopløst/i.test(v.status)) {
                    meld('advarsel', f.bons, f.name, `CVR ${f.cvr} = "${v.navn}" er ${v.status} — kan ikke være en aktiv kunde`);
                    continue;
                }
                const paraply = brug.get(nr) >= 3;
                const lighed = dice(f.name, v.navn);
                if (!paraply && lighed < 0.35)
                    meld('advarsel', f.bons, f.name, `CVR ${f.cvr} tilhører "${v.navn}" — et andet firma (lighed ${lighed.toFixed(2)})`);
                else if (paraply && lighed < 0.35) paraplyer.set(nr, (paraplyer.get(nr) || 0) + 1);
            }

            if (paraplyer.size) {
                const top = [...paraplyer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
                    .map(([nr, n]) => `${virk.get(nr)?.navn || nr} (${n})`).join(' · ');
                console.log(`(${[...paraplyer.values()].reduce((a, b) => a + b, 0)} afdelinger bruger et paraply-CVR — forventet, ikke en fejl: ${top})\n`);
            }
        }
    }

    // ── 3. Stamdata-skrald fra berigelsen ─────────────────────────────
    const skrald = firmaer.filter(f => {
        const v = String(f.employee_count ?? '').trim();
        if (!v) return false;
        if (/^ANTAL_/i.test(v)) return true;          // rå Virk-enum
        return /^\d+$/.test(v) && Number(v) > 5000;   // datoserier o.l. — ingen kunde har 40.000 ansatte
    });
    if (skrald.length) {
        const enum_ = skrald.filter(f => /^ANTAL_/i.test(String(f.employee_count))).length;
        meld('data', null, `${skrald.length} firmaer`, `employee_count er ikke et antal ansatte (${enum_} med rå "ANTAL_*"-enum, ${skrald.length - enum_} med tal over 5.000 — ligner datoserier)`);
    }

    // ── Rapport ───────────────────────────────────────────────────────
    const vis = (nøgle, overskrift, forklaring) => {
        const r = fund[nøgle].filter(x => ALLE || x.bons > 0 || x.bons === null);
        console.log(`── ${overskrift} (${r.length}) ──`);
        if (forklaring) console.log(`   ${forklaring}`);
        if (!r.length) return console.log('   ingen\n');
        r.sort((a, b) => (b.bons ?? -1) - (a.bons ?? -1)).forEach(x =>
            console.log(`   ${x.bons === null ? '   —' : String(x.bons).padStart(3) + ' bons'}  ${String(x.navn).slice(0, 32).padEnd(34)} ${x.tekst}`));
        console.log('');
    };
    console.log('');
    vis('kritisk',  'KRITISK — fakturaen kan gå til den forkerte', 'Ret disse før næste fakturering.');
    vis('advarsel', 'ADVARSEL — koblingen eller CVR ser forkert ud', 'Kræver et menneskes blik; kan være en forkortelse eller en ægte fejl.');
    vis('data',     'STAMDATA — forkerte værdier, ingen fakturarisiko');
    console.log(`Kun firmaer med bons det seneste år vises${ALLE ? ' (--alle er sat: alle vises)' : ' — brug --alle for resten'}.`);
})().catch(e => { console.error('\n' + e.stack); process.exit(1); });
