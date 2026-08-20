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

    const ud = [['domaene', 'kontakter', 'bons', 'kr', 'seneste', 'forslag_nr', 'forslag_navn', 'forslag_ean', 'score', 'godkendt_nr'].join(';')];
    console.log(`\nFirma ${firma.id} "${firma.name}"  ·  CVR ${firma.cvr || '—'}  ·  EAN ${firma.ean || '—'}  ·  e-conomic ${firma.economic_customer_id || '—'}`);
    console.log(`${rækker.length} e-mail-domæner${udenMail ? ` · ${udenMail} kontakter uden e-mail (kan ikke placeres)` : ''}\n`);

    for (const r of rækker) {
        const k = kandidater(r.domaene);
        const privat = /^(gmail|hotmail|outlook|live|yahoo|icloud)\./.test(r.domaene + '.');
        console.log(`  ${r.domaene.padEnd(16)} ${String(r.kontakter).padStart(3)} kontakter · ${String(r.bons).padStart(3)} bons · ${String(r.kr).padStart(8)} kr · sidst ${r.seneste || '—'}`);
        if (privat) console.log('      privat mailadresse — hører formentlig til en af de andre grupper, eller er en enkeltbestilling');
        else if (!k.length) console.log(`      intet belæg for et match — vælg blandt de ${familie.length} kunder i familien (se listen nederst)`);
        for (const c of k) console.log(`      ${String(c.k.customerNumber).padStart(4)}  ${String(c.k.name).slice(0, 46).padEnd(48)} EAN ${cif(c.k.ean) || '—'}  (${c.score.toFixed(2)})`);
        console.log('');
        ud.push([r.domaene, r.kontakter, r.bons, r.kr, r.seneste || '',
                 k[0]?.k.customerNumber ?? '', k[0]?.k.name ?? '', cif(k[0]?.k.ean) || '',
                 k[0] ? k[0].score.toFixed(2) : '', ''].map(csv).join(';'));
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
    console.log('\n   Scriptet skriver ikke. Selve opdelingen — nye firma-rækker, flytning af');
    console.log('   kontakter og bons — bygges når planen er godkendt.');
})().catch(e => { console.error('\n' + e.stack); process.exit(1); });
