#!/usr/bin/env node
'use strict';
/**
 * scripts/company-split-plan.js
 * ────────────────────────────────────────────────────────────
 * READ-ONLY: forbered opdelingen af et paraply-firma.
 *
 * Nogle Bon-firmaer er ikke ét firma. "Københavns Universitet" er 41
 * kontaktpersoner fra ni institutter, som hver har SIN egen e-conomic-kunde og
 * sit eget EAN. Der findes derfor ikke ét rigtigt kundenummer at koble rækken
 * til — uanset hvad man vælger, sendes de fleste fakturaer til det forkerte
 * institut. Rækken skal deles op.
 *
 * Scriptet grupperer firmaets kontakter og bons efter e-mail-domæne, finder
 * kandidater i e-conomic til hver gruppe, og skriver en review-fil. Det SKRIVER
 * ALDRIG — opdelingen flytter bons og kontakter og skal godkendes først.
 *
 *   node --experimental-sqlite scripts/company-split-plan.js --company 2582
 *   node --experimental-sqlite scripts/company-split-plan.js --company 2582 --db data/bon.db
 *
 *   --company <id>  firmaet der skal deles (påkrævet)
 *   --out <fil>     review-fil (default: data/split-plan-<id>.csv)
 * ────────────────────────────────────────────────────────────
 */
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const eco = require('../services/economicAdapter');

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const DB_PATH = arg('--db', process.env.DB_PATH || 'data/bon.db');
const FIRMA   = Number(arg('--company', ''));
const OUT     = arg('--out', null);
if (!Number.isInteger(FIRMA)) { console.error('Brug: --company <id>'); process.exit(2); }

const cif = (s) => String(s || '').replace(/\D/g, '');
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
const csv = (v) => { const s = String(v ?? '').replace(/[\r\n]+/g, ' ').trim(); return /[;"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

(async () => {
    const db = new DatabaseSync(`file:${DB_PATH}?mode=ro`, { readOnly: true });
    const firma = db.prepare('SELECT id, name, cvr, ean, economic_customer_id FROM companies WHERE id = ?').get(FIRMA);
    if (!firma) { console.error(`Firma ${FIRMA} findes ikke.`); process.exit(1); }

    // Gruppér efter e-mail-domæne. Domænet er det bedste signal vi har for hvilket
    // institut/afdeling en bestilling hører til — bedre end firmanavnet, som er ét
    // for dem alle, og bedre end kontaktens navn.
    const rækker = db.prepare(`
        SELECT lower(TRIM(replace(replace(substr(c.email, instr(c.email,'@')+1), char(10), ''), char(13), ''))) AS domaene,
               COUNT(DISTINCT c.id) AS kontakter,
               COUNT(b.id)          AS bons,
               ROUND(COALESCE(SUM(b.total_price), 0)) AS kr,
               MAX(b.delivery_date) AS seneste
        FROM customers c
        LEFT JOIN bons b ON b.customer_id = c.id AND b.company_id = c.company_id
        WHERE c.company_id = ? AND COALESCE(TRIM(c.email),'') <> ''
        GROUP BY domaene
        ORDER BY bons DESC, kontakter DESC
    `).all(FIRMA);
    // Adressefordelingen afslører om et domæne dækker ÉT sted eller mange. SUND er
    // et fakultet: @sund.ku.dk deles af 13 institutter på hver sin adresse, mens
    // bio.ku.dk har flere bygninger men én dominerende. Uden det tjek ville
    // værktøjet foreslå at samle 13 institutter under ét kundenummer.
    const veje = db.prepare(`
        SELECT lower(TRIM(replace(replace(substr(c.email, instr(c.email,'@')+1), char(10), ''), char(13), ''))) AS domaene,
               lower(TRIM(COALESCE(a.street_name,''))) AS vej, COUNT(b.id) AS bons
        FROM customers c
        JOIN bons b ON b.customer_id = c.id AND b.company_id = c.company_id
        LEFT JOIN addresses a ON a.id = b.delivery_address_id
        WHERE c.company_id = ? AND COALESCE(TRIM(c.email),'') <> ''
        GROUP BY domaene, vej
    `).all(FIRMA);
    const vejePr = new Map();
    for (const v of veje) {
        if (!v.vej) continue;
        const l = vejePr.get(v.domaene) || [];
        l.push(v); vejePr.set(v.domaene, l);
    }
    /** Andelen af bons på den hyppigste vej. Lav andel ⇒ domænet dækker flere steder. */
    const spredning = (domaene) => {
        const l = vejePr.get(domaene) || [];
        const i = l.reduce((n, v) => n + v.bons, 0);
        if (!i) return { andel: 1, top: null, veje: l };
        const top = l.slice().sort((a, b) => b.bons - a.bons)[0];
        return { andel: top.bons / i, top, veje: l.sort((a, b) => b.bons - a.bons) };
    };

    // Kontakterne, så et spredt domæne kan deles pr. person i stedet for pr. domæne
    const kontakterPr = db.prepare(`
        SELECT lower(TRIM(c.email)) AS email, c.first_name || ' ' || COALESCE(c.last_name,'') AS navn,
               (SELECT lower(TRIM(COALESCE(a.street_name,'')))
                  FROM bons b2 LEFT JOIN addresses a ON a.id = b2.delivery_address_id
                 WHERE b2.customer_id = c.id AND b2.company_id = c.company_id
                   AND COALESCE(a.street_name,'') <> ''
                 GROUP BY a.street_name ORDER BY COUNT(*) DESC LIMIT 1) AS vej,
               lower(TRIM(replace(replace(substr(c.email, instr(c.email,'@')+1), char(10), ''), char(13), ''))) AS domaene,
               (SELECT COUNT(*) FROM bons b WHERE b.customer_id = c.id AND b.company_id = c.company_id) AS bons
        FROM customers c WHERE c.company_id = ? AND COALESCE(TRIM(c.email),'') <> ''
        ORDER BY bons DESC
    `).all(FIRMA);

    const udenMail = db.prepare(`SELECT COUNT(*) n FROM customers WHERE company_id = ? AND COALESCE(TRIM(email),'') = ''`).get(FIRMA).n;
    db.close();

    if (!eco.isConfigured()) { console.error('e-conomic er ikke konfigureret — kan ikke foreslå kunder.'); process.exit(2); }
    let kunder = [], skip = 0;
    while (true) {
        const r = await eco.rest('/customers?pagesize=100&skippages=' + skip);
        kunder = kunder.concat(r.collection || []);
        if (!r.pagination?.nextPage || ++skip > 30) break;
    }

    // Familien: kunder der overhovedet kan høre til denne paraply. Uden den
    // foreslog "sund.ku.dk" en sundhedspleje under Københavns Kommune, og
    // "di.ku.dk" en kunde ved navn "Diverse". Et forkert forslag er værre end
    // ingen, fordi det ser ud som om spørgsmålet er besvaret.
    // Det MEST karakteristiske ord i paraply-navnet, ikke bare et hvilket som helst:
    // "københavns" deles med Københavns Kommune, mens "universitet" ikke gør.
    const kendeord = norm(firma.name).split(' ').filter(o => o.length >= 5)
        .sort((a, b) => b.length - a.length)[0] || '';
    const familie = kunder.filter(k => {
        if (cif(firma.ean) && cif(k.ean) === cif(firma.ean)) return true;
        if (cif(firma.cvr) && cif(k.corporateIdentificationNumber) === cif(firma.cvr)) return true;
        return kendeord && norm(k.name).includes(kendeord);
    });

    /**
     * Kandidater til én domæne-gruppe — kun når der er REELT belæg:
     *   · domænets første led ("plen", "bio") står i kundenavnet, eller
     *   · kunden har præcis paraply-firmaets EAN.
     * Navne-lighed alene rækker ikke: alle KU-kunder ligner hinanden, så den
     * ville udpege den største gruppe hver gang uanset domæne.
     * Led på under tre tegn ("di") springes over — de rammer tilfældige ord.
     */
    function kandidater(domaene) {
        const led = domaene.split('.')[0];
        const privat = /^(gmail|hotmail|outlook|live|yahoo|icloud|me)$/.test(led);
        if (privat) return [];
        if (led.length < 3) return [];   // "di" rammer tilfældige ord
        return familie.map(k => {
            const n = norm(k.name);
            // Domæne-leddet i navnet er det ENESTE der udpeger en afdeling. EAN og
            // navne-lighed må kun rangere blandt dem der allerede har belæg — ellers
            // foreslås den samme store afdeling til hvert eneste domæne.
            if (!new RegExp(`\\b${led}`, 'i').test(n)) return { k, score: 0 };
            let score = 1;
            if (cif(firma.ean) && cif(k.ean) === cif(firma.ean)) score += 0.5;
            return { k, score: score + dice(firma.name, k.name) * 0.3 };
        }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 4);
    }

    const ud = [['domaene', 'kontakter', 'bons', 'kr', 'seneste', 'adresse', 'forslag_nr', 'forslag_navn', 'forslag_ean', 'score', 'godkendt_nr'].join(';')];
    console.log(`\nFirma ${firma.id} "${firma.name}"  ·  CVR ${firma.cvr || '—'}  ·  EAN ${firma.ean || '—'}  ·  e-conomic ${firma.economic_customer_id || '—'}`);
    console.log(`${rækker.length} e-mail-domæner${udenMail ? ` · ${udenMail} kontakter uden e-mail (kan ikke placeres)` : ''}\n`);

    for (const r of rækker) {
        const k = kandidater(r.domaene);
        const privat = /^(gmail|hotmail|outlook|live|yahoo|icloud)\./.test(r.domaene + '.');
        const sp = spredning(r.domaene);
        // Ingen dominerende adresse + flere personer ⇒ domænet er formentlig et
        // fakultet, ikke ét institut. Så må det deles pr. person, ikke pr. domæne.
        const spredt = !privat && r.kontakter > 1 && sp.top && sp.andel < 0.5;
        console.log(`  ${r.domaene.padEnd(16)} ${String(r.kontakter).padStart(3)} kontakter · ${String(r.bons).padStart(3)} bons · ${String(r.kr).padStart(8)} kr · sidst ${r.seneste || '—'}`);
        if (spredt) {
            console.log(`      ⚠ leverancerne er spredt over ${sp.veje.length} adresser (hyppigste kun ${Math.round(sp.andel * 100)} %)`);
            console.log('        — domænet dækker formentlig flere institutter. Deles pr. person nedenfor:');
            for (const kt of kontakterPr.filter(x => x.domaene === r.domaene)) {
                console.log(`        ${kt.email.padEnd(24)} ${String(kt.bons).padStart(2)} bons  `
                    + `${String(kt.navn).slice(0, 22).padEnd(24)}${kt.vej ? 'leverer til ' + kt.vej : 'ingen adresse'}`);
            }
            console.log('        Adressen er sporet: den peger på instituttet, hvor domænet kun peger på fakultetet.');
            console.log('');
            for (const kt of kontakterPr.filter(x => x.domaene === r.domaene)) {
                ud.push([kt.email, 1, kt.bons, '', '', kt.vej || '', '', '', '', '', ''].map(csv).join(';'));
            }
            continue;
        }
        if (sp.top && sp.andel < 1) console.log(`      leveres oftest til ${sp.top.vej} (${Math.round(sp.andel * 100)} % af bons)`);
        if (privat) console.log('      privat mailadresse — hører formentlig til en af de andre grupper, eller er en enkeltbestilling');
        else if (!k.length) console.log(`      intet belæg for et match — vælg blandt de ${familie.length} kunder i familien (se listen nederst)`);
        for (const c of k) console.log(`      ${String(c.k.customerNumber).padStart(4)}  ${String(c.k.name).slice(0, 46).padEnd(48)} EAN ${cif(c.k.ean) || '—'}  (${c.score.toFixed(2)})`);
        console.log('');
        // Private adresser er folk fra afdelingerne der har bestilt til sig selv.
        // De skal ikke have en egen firma-række — derfor "-" på forhånd.
        ud.push([r.domaene, r.kontakter, r.bons, r.kr, r.seneste || '', sp.top?.vej || '',
                 k[0]?.k.customerNumber ?? '', k[0]?.k.name ?? '', cif(k[0]?.k.ean) || '',
                 k[0] ? k[0].score.toFixed(2) : '', privat ? '-' : ''].map(csv).join(';'));
    }

    // Opslagsliste: de grupper uden belæg skal kunne udfyldes uden at slå op i e-conomic.
    if (rækker.some(r => !kandidater(r.domaene).length)) {
        console.log(`── Kunder i familien (${familie.length}) — til de grupper uden belæg ──`);
        familie.sort((a, b) => a.customerNumber - b.customerNumber).forEach(k =>
            console.log(`   ${String(k.customerNumber).padStart(4)}  ${String(k.name).slice(0, 52).padEnd(54)} EAN ${cif(k.ean) || '—'}`));
        console.log('');
    }

    const fil = OUT || `data/split-plan-${FIRMA}.csv`;
    fs.writeFileSync(fil, ud.join('\n') + '\n');
    console.log(`→ Skrev ${rækker.length} rækker til ${fil}`);
    console.log('   godkendt_nr er TOM med vilje — forslagene er gæt, og flere kunder deler ofte EAN.');
    console.log('   Udfyld kundenummeret pr. domæne (eller "-" for at lade gruppen blive på paraply-rækken).');
    console.log('   Private adresser er sat til "-" på forhånd — de er folk fra afdelingerne, ikke egne firmaer.');
    console.log('\n   Scriptet skriver ikke. Selve opdelingen — nye firma-rækker, flytning af');
    console.log('   kontakter og bons — bygges når planen er godkendt.');
})().catch(e => { console.error('\n' + e.stack); process.exit(1); });
