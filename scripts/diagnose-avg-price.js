// scripts/diagnose-avg-price.js
// ============================================================
// Read-only: hvor kommer et produkts GENNEMSNITSPRIS fra — og kan Grocy
// komme af med den igen?
//
// BAGGRUNDEN
// #557 gjorde gennemsnittet til anker frem for seneste køb, fordi seneste køb
// er prisen på ét bilag og hopper. Effektmålingen (`npm run audit:kostpris-kilder`)
// viste bagefter at gennemsnittet for en håndfuld varer ikke bare er ustabilt,
// men forkert: Chilli Pulver 20.012 kr/kg, Lufttørret Skinke 5.504 kr/kg,
// RR Boks 95,71 kr. Et køb tastet i forkert enhed ligger i historikken, og et
// gennemsnit renser ikke en enhedsfejl — det konserverer den.
//
// ASYMMETRIEN, som er hele grunden til at dette skal måles:
//   `last_price` HELER sig selv — næste rigtige køb erstatter den.
//   `avg_price` gør IKKE — den kan kun fortyndes, og hvis den dårlige postering
//   også bærer en stor mængde, sker selv dét aldrig.
// Kan historikken ikke rettes, er "gennemsnittet er ankeret" altså ikke sandt
// for præcis de varer hvor det betyder mest.
//
// HVAD SCRIPTET SVARER PÅ
//   1. Hvilken formel genskaber Grocys `avg_price`? (vejet over køb med
//      undone=0 / over alle køb / simpelt snit). Vi GÆTTER ikke på Grocys
//      interne view — vi regner de tre og ser hvilken der rammer.
//   2. Hvilke posteringer trækker snittet skævt — dato, mængde, pris, undone.
//   3. Findes lagerposten bag posteringen stadig? Det afgør i praksis om
//      Grocys "fortryd postering" kan bruges, eller om varen kun kan rettes
//      et andet sted.
//
// SKRIVER INTET. Alle Grocy-kald er GET; databasen åbnes slet ikke.
//
// Kør fra projektroden (scriptet loader selv .env):
//   npm run diagnose:snitpris
//   node scripts/diagnose-avg-price.js --produkt 42 --produkt 118
//   node scripts/diagnose-avg-price.js --alle
// ============================================================

'use strict';

const fs   = require('fs');
const path = require('path');

// Samme .env-indlæsning som scripts/audit-kostpris-kilder.js. `--env-file`
// duer ikke alene: den fejler hårdt hvis filen mangler.
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
}

const C = { dim: '\x1b[2m', red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m', b: '\x1b[1m', off: '\x1b[0m' };

const args    = process.argv.slice(2);
const ALLE    = args.includes('--alle');
const TEST    = args.includes('--test');
const IDS     = args.reduce((acc, a, i) => (a === '--produkt' && args[i + 1]) ? acc.concat(String(args[i + 1])) : acc, []);
const WARN_PCT = 30;          // samme tærskel som services/recipeCost.js
const LOG_LIMIT = 5000;       // /objects/stock_log giver 500 UDEN limit — se CLAUDE.md

const kr  = n => (n == null) ? '—' : Number(n).toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = n => (n == null) ? '—' : (n > 0 ? '+' : '') + Number(n).toFixed(0) + ' %';
const pad = (s, n) => String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const pos = v => { const n = num(v); return (n != null && n > 0) ? n : null; };

function grocyConfig() {
    const pre = TEST ? 'GROCY_TEST' : 'GROCY_HQ';
    const url = process.env[pre + '_URL'] || process.env.GROCY_API_URL;
    const key = process.env[pre + '_KEY'] || process.env.GROCY_API_KEY;
    if (!url || !key) {
        console.error(`Mangler ${pre}_URL / ${pre}_KEY i .env — kør scriptet på serveren.`);
        process.exit(2);
    }
    return { url: url.replace(/\/+$/, ''), key };
}

async function main() {
    const { url, key } = grocyConfig();
    const get = async p => {
        const r = await fetch(url + p, { headers: { 'GROCY-API-KEY': key } });
        if (!r.ok) throw new Error('GET ' + p + ' → ' + r.status);
        return r.json();
    };

    console.log(`${C.b}Snitpris-diagnose${C.off} mod ${url}${TEST ? ' (grocytest)' : ''}\n`);

    const [products, stock] = await Promise.all([
        get('/objects/products'),
        get('/objects/stock'),
    ]);
    const navn = new Map(products.map(p => [String(p.id), p.name]));
    const liveStockIds = new Set(stock.map(s => String(s.id)));

    // ── Hvilke produkter skal ses efter? ────────────────────────────────
    let kandidater;
    if (IDS.length) {
        kandidater = IDS.map(id => ({ id, dev: null }));
    } else {
        process.stdout.write(`Henter priser for ${products.length} produkter … `);
        const fundet = [];
        let i = 0;
        await Promise.all(Array.from({ length: 6 }, async () => {
            while (i < products.length) {
                const p = products[i++];
                try {
                    const d = await get('/stock/products/' + p.id);
                    const last = pos(d.last_price), avg = pos(d.avg_price ?? d.average_price);
                    if (last == null || avg == null) continue;
                    const dev = (last - avg) / avg * 100;
                    if (Math.abs(dev) > WARN_PCT) fundet.push({ id: String(p.id), dev });
                } catch { /* uden pris — ikke interessant her */ }
            }
        }));
        fundet.sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev));
        console.log(`${fundet.length} med afvigelse over ${WARN_PCT} %.\n`);
        kandidater = ALLE ? fundet : fundet.slice(0, 8);
    }

    let kanFortrydes = 0, kanIkke = 0, ukendt = 0, uforklaret = 0;

    for (const k of kandidater) {
        const d = await get('/stock/products/' + k.id).catch(() => null);
        if (!d) { console.log(`${C.red}#${k.id} — kunne ikke hentes${C.off}\n`); continue; }

        const last = pos(d.last_price);
        const avg  = pos(d.avg_price ?? d.average_price);
        const enhed = d.quantity_unit_stock?.name || '';
        console.log(`${C.b}#${k.id} ${navn.get(String(k.id)) || d.product?.name || ''}${C.off}`);
        console.log(`  seneste køb ${kr(last)} · gennemsnit ${C.red}${kr(avg)}${C.off} kr/${enhed}` +
                    (last != null && avg != null ? `  (${pct((last - avg) / avg * 100)})` : ''));

        // ── Hvilken formel genskaber Grocys tal? ────────────────────────
        const log = await get(`/objects/stock_log?query%5B%5D=product_id%3D${k.id}&limit=${LOG_LIMIT}`).catch(() => []);
        const koeb = log.filter(r => r.transaction_type === 'purchase' && pos(r.price) != null && num(r.amount) > 0);
        const aktive = koeb.filter(r => String(r.undone) !== '1');

        const vejet = rows => {
            const sumA = rows.reduce((s, r) => s + num(r.amount), 0);
            return sumA > 0 ? rows.reduce((s, r) => s + pos(r.price) * num(r.amount), 0) / sumA : null;
        };
        const simpelt = rows => rows.length ? rows.reduce((s, r) => s + pos(r.price), 0) / rows.length : null;

        const formler = [
            ['vejet over køb, undone=0', vejet(aktive)],
            ['vejet over ALLE køb',      vejet(koeb)],
            ['simpelt snit, undone=0',   simpelt(aktive)],
        ];
        const traf = formler.find(([, v]) => v != null && avg != null && Math.abs(v - avg) / avg < 0.005);
        if (traf) {
            console.log(`  ${C.grn}Grocys snit = ${traf[0]}${C.off}   ${C.dim}(${kr(traf[1])})${C.off}`);
        } else {
            uforklaret++;
            console.log(`  ${C.yel}Ingen af de tre formler rammer${C.off} ${C.dim}(` +
                        formler.map(([n, v]) => `${n}: ${kr(v)}`).join(' · ') + `)${C.off}`);
        }

        // ── Hvilke posteringer trækker skævt? ───────────────────────────
        const priser = aktive.map(r => pos(r.price)).sort((a, b) => a - b);
        const median = priser.length ? priser[Math.floor(priser.length / 2)] : null;
        const skæve = aktive
            .map(r => ({ r, afv: median ? Math.abs(pos(r.price) - median) / median * 100 : 0 }))
            .filter(x => x.afv > WARN_PCT)
            .sort((a, b) => b.afv - a.afv)
            .slice(0, 6);

        if (!skæve.length) {
            console.log(`  ${C.dim}Ingen enkeltpostering skiller sig ud fra medianen (${kr(median)}).${C.off}`);
        } else {
            console.log(`  ${C.dim}median ${kr(median)} · ${aktive.length} køb i historikken · skæve posteringer:${C.off}`);
            console.log(`    ${C.dim}${pad('dato', 12)}${padL('mængde', 10)}${padL('pris', 12)}${padL('afv', 8)}  lagerpost${C.off}`);
            for (const { r, afv } of skæve) {
                // Tre udfald, ikke to. Bærer rækken slet ingen `stock_id`, ved vi
                // ikke om lagerposten findes — og "væk" ville være en påstand.
                let status;
                if (!r.stock_id)                              { status = `${C.yel}ingen lagerpost på rækken${C.off}`; ukendt++; }
                else if (liveStockIds.has(String(r.stock_id))) { status = `${C.grn}findes — kan fortrydes${C.off}`;    kanFortrydes++; }
                else                                          { status = `${C.red}væk — kan ikke fortrydes${C.off}`;   kanIkke++; }
                console.log(`    ${pad(String(r.row_created_timestamp || '').slice(0, 10), 12)}` +
                            `${padL(num(r.amount), 10)}${padL(kr(pos(r.price)), 12)}${padL(pct(afv), 8)}  ` + status);
            }
        }
        console.log('');
    }

    // ── Konklusion ──────────────────────────────────────────────────────
    console.log(`${C.b}Kan historikken renses?${C.off}`);
    console.log(`  ${kanFortrydes} skæve posteringer har stadig deres lagerpost — Grocys "fortryd postering" kan tage dem.`);
    console.log(`  ${kanIkke} har ikke — varen er brugt op, og posteringen kan ikke fortrydes.`);
    if (ukendt) console.log(`  ${ukendt} bærer ingen lagerpost-reference — ved ikke.`);
    if (uforklaret) {
        console.log(`  ${C.yel}${uforklaret} produkter hvor ingen af de tre formler genskabte Grocys snit${C.off}` +
                    ` ${C.dim}— så ved vi ikke hvad tallet er, og "ret historikken" er ikke nødvendigvis vejen.${C.off}`);
    }
    if (kanIkke > 0) {
        console.log(`\n  ${C.dim}Er der posteringer der ikke kan fortrydes, kan gennemsnittet ikke bringes${C.off}`);
        console.log(`  ${C.dim}i orden i Grocy — og så skal kostprisen kunne sættes i Bon i stedet.${C.off}`);
    }
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
