// scripts/diagnose-partial-consume.js
// ============================================================
// Hvorfor fejlede lagertrækket på de enkelte produkter?
//
// Vagthunden (check-inventory-deduct.js) siger HVILKE produkter der fejlede.
// Den siger ikke HVORFOR — og uden det kan man ikke vide om lageret skal rettes
// i hånden, om en kobling mangler, eller om Grocy var nede i to sekunder.
//
// Svaret har hele tiden ligget i `changelog`: `consumeRecipes` gemmer hvert
// produkts `err.message` i `grocy_consume`-postens payload. Der var blot ingen
// måde at læse den uden at åbne bonen i UI'et, én ad gangen.
//
// Scriptet grupperer fejlene på BESKED. Det er den gruppering der afgør noget:
// fire bons der fejler på de samme produkter med den samme besked er ÉN årsag,
// ikke fire uheld — og den slags kan man kun se når man ser dem ved siden af
// hinanden.
//
// Vigtigt om hvad `success: false` betyder: mængden er allerede klampet til det
// der ER på lageret (`Math.min(needed, available)`), så det er IKKE "for lidt
// på lager" — den situation giver `success: true` + `partial` + en linje på
// indkøbslisten. En fejl her er selve Grocy-kaldet der svarede noget andet
// end 2xx.
//
// READ-ONLY. Der findes ingen --apply. Rører hverken bons eller Grocy.
//
// ── Brug ────────────────────────────────────────────────────────────────────
//
//   node --experimental-sqlite scripts/diagnose-partial-consume.js            # 7 dage
//   node --experimental-sqlite scripts/diagnose-partial-consume.js --days 30
//   node --experimental-sqlite scripts/diagnose-partial-consume.js --bon B4239
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

const { getDb }              = require('../db/database');
const { offsetISO, todayISO } = require('../db/helpers');

const args = process.argv.slice(2);
const argOf = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const DAYS  = Math.max(1, parseInt(argOf('--days'), 10) || 7);
const BON   = argOf('--bon');

// Samme tre payload-former som vagthunden og changelog-modalen kender.
function parseResults(raw) {
    const txt = String(raw == null ? '' : raw).trim();
    if (!txt || txt === 'event_prep_owns_stock') return null;
    let parsed;
    try { parsed = JSON.parse(txt); } catch { return null; }
    return Array.isArray(parsed) ? parsed
         : (parsed && Array.isArray(parsed.results)) ? parsed.results
         : null;
}

// Grocys fejltekster bærer tal og id'er der er unikke pr. produkt. Skal beskeder
// kunne grupperes, må de tal ud — ellers bliver hver fejl sin egen "årsag", og
// så er grupperingen ingenting værd.
function normalizeError(msg) {
    return String(msg || '(ingen besked)')
        .replace(/\b\d+([.,]\d+)?\b/g, 'N')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
}

function main() {
    const db = getDb();

    const rows = BON
        ? db.prepare(`
            SELECT b.id, b.bon_number, b.delivery_date, b.inventory_deduct_status
              FROM bons b WHERE b.bon_number = ?`).all(BON)
        : db.prepare(`
            SELECT b.id, b.bon_number, b.delivery_date, b.inventory_deduct_status
              FROM bons b
             WHERE b.inventory_deduct_status IN ('partial','failed')
               AND b.delivery_date >= ? AND b.delivery_date <= ?
             ORDER BY b.delivery_date, b.id`).all(offsetISO(-DAYS), todayISO());

    if (!rows.length) {
        console.log(BON
            ? `Ingen bon med nummer ${BON}.`
            : `Ingen bons med delvist eller fejlet lagertræk de seneste ${DAYS} dage. Intet at diagnosticere.`);
        return 0;
    }

    const payloadFor = db.prepare(`
        SELECT c.new_value, c.created_at FROM changelog c
         WHERE c.entity_type = 'bon' AND c.entity_id = ?
           AND c.action = 'grocy_consume'
         ORDER BY c.id DESC LIMIT 1`);

    const byError = new Map();   // normaliseret besked → { raw, produkter:Map(navn→Set(bon)) }
    let udenSpor = 0;

    console.log(`\nBons med delvist/fejlet lagertræk${BON ? '' : ` (seneste ${DAYS} dage)`}\n`);

    for (const b of rows) {
        const cl = payloadFor.get(b.id);
        const results = cl ? parseResults(cl.new_value) : null;
        if (!results) {
            udenSpor++;
            console.log(`  #${b.bon_number}  ${b.delivery_date}  ${b.inventory_deduct_status}`
                      + `  — ingen læsbar grocy_consume-post (trækket kan være ældre end sporet)`);
            continue;
        }
        const failed = results.filter(r => r && r.success === false);
        const okAntal = results.length - failed.length;
        console.log(`  #${b.bon_number}  ${b.delivery_date}  ${b.inventory_deduct_status}`
                  + `  — ${okAntal} trukket, ${failed.length} fejlede`
                  + (cl.created_at ? `  (${cl.created_at})` : ''));
        for (const f of failed) {
            const navn = String(f.product_name || `produkt #${f.product_id ?? '?'}`);
            const beskedRaw = f.error || '(ingen besked)';
            const key = normalizeError(beskedRaw);
            console.log(`        ✗ ${navn}${f.amount != null ? `  (ville trække ${f.amount})` : ''}`);
            console.log(`          ${beskedRaw}`);
            if (!byError.has(key)) byError.set(key, { raw: beskedRaw, produkter: new Map() });
            const g = byError.get(key);
            if (!g.produkter.has(navn)) g.produkter.set(navn, new Set());
            g.produkter.get(navn).add(b.bon_number);
        }
    }

    if (byError.size) {
        console.log(`\n${'─'.repeat(60)}\nSamlet, grupperet på fejlbesked\n`);
        // Størst først: den gruppe der rammer flest bons er den der skal løses.
        const grupper = [...byError.values()].sort((a, b) => {
            const bons = g => new Set([...g.produkter.values()].flatMap(s => [...s])).size;
            return bons(b) - bons(a);
        });
        for (const g of grupper) {
            const bons = new Set([...g.produkter.values()].flatMap(s => [...s]));
            console.log(`  ${g.raw}`);
            console.log(`    rammer ${g.produkter.size} produkt(er) på ${bons.size} bon(s): `
                      + [...bons].join(', '));
            for (const [navn, s] of g.produkter) {
                console.log(`      • ${navn}  (${s.size} bon${s.size === 1 ? '' : 's'})`);
            }
            console.log('');
        }
        console.log(`  Rammer den samme besked de samme produkter på flere bons, er det ÉN årsag —`);
        console.log(`  ikke flere uheld. Start dér.\n`);
    }
    if (udenSpor) {
        console.log(`  ${udenSpor} bon(s) havde ingen læsbar grocy_consume-post.\n`);
    }
    return 0;
}

if (require.main === module) {
    try { process.exit(main()); }
    catch (err) { console.error(`FATAL: ${err.message}\n${err.stack}`); process.exit(2); }
}
module.exports = { parseResults, normalizeError };
