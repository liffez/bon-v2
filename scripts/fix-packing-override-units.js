// scripts/fix-packing-override-units.js
// ==========================================
// Engangs-oprydning efter #352.
//
// Pakkelistens redigerede mængder blev gemt i produktets VISNINGS-enhed, men
// bruges ved LEVERET som om de var i LAGER-enhed. Rækker gemt før rettelsen
// står derfor i blandede enheder. Heldigvis gemmer tabellen `unit` med, så
// hver række kan afgøres entydigt.
//
// Scriptet konverterer kun rækker hvor den gemte enhed AFVIGER fra produktets
// lager-enhed. Rækker der allerede står i lager-enhed røres ikke — det gør
// scriptet idempotent, for rettelsen skriver netop lager-enhedens navn i `unit`.
//
// Kør dry-run først (skriver ikke):
//   node --experimental-sqlite scripts/fix-packing-override-units.js
// Og derefter:
//   node --experimental-sqlite scripts/fix-packing-override-units.js --apply
//
// Kræver Grocy-adgang (læser produkternes lager-enhed + konverteringer).
// ==========================================

const path = require('path');
const fs = require('fs');

// Load .env (Grocy API-credentials osv.)
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
}
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');
process.env.DB_PATH = DB_PATH;

const { openDb } = require('../db/compat');
const grocy = require('../services/grocyAdapter');
const { findConversionFactor } = require('../services/quConvert');

const APPLY = process.argv.includes('--apply');

// autoFormatAmount kan vise "g"/"ml" selvom produktet lagerføres i kg/l.
// Normalisering så navne-sammenligningen ikke falder over kg vs. Kilo.
const norm = (s) => String(s || '').trim().toLowerCase()
    .replace(/^kilo$/, 'kg').replace(/^gram$/, 'g')
    .replace(/^liter$/, 'l').replace(/^stk\.$/, 'stk');

(async () => {
    const db = openDb(DB_PATH);
    const rows = db.prepare(`
        SELECT rowid AS rid, bon_id, product_id, product_name, packed_amount, unit
        FROM prep_packing_overrides ORDER BY bon_id, product_id
    `).all();

    if (!rows.length) {
        console.log('Ingen rækker i prep_packing_overrides — intet at gøre.');
        return;
    }

    const [products, units, conversions] = await Promise.all([
        grocy.getProducts(), grocy.getQuantityUnits(), grocy.getQuantityUnitConversions(),
    ]);
    const pMap = new Map(products.map(p => [String(p.id), p]));
    const uMap = new Map(units.map(u => [String(u.id), u]));
    // enhedsnavn (normaliseret) → qu_id, så den gemte tekst kan slås op
    const byName = new Map();
    for (const u of units) {
        for (const n of [u.name, u.name_short]) if (n) byName.set(norm(n), u.id);
    }

    const planned = [], skipped = [], manual = [];

    for (const r of rows) {
        const p = pMap.get(String(r.product_id));
        if (!p) { manual.push({ ...r, why: 'produkt findes ikke i Grocy' }); continue; }

        const stockUnit = uMap.get(String(p.qu_id_stock));
        const stockName = stockUnit ? (stockUnit.name_short || stockUnit.name) : null;
        if (!stockName) { manual.push({ ...r, why: 'produkt uden lager-enhed' }); continue; }

        if (!r.unit) { manual.push({ ...r, why: 'ingen enhed gemt — kan ikke afgøres' }); continue; }

        if (norm(r.unit) === norm(stockName)) {
            skipped.push({ ...r, stockName });   // allerede i lager-enhed
            continue;
        }

        const fromQu = byName.get(norm(r.unit));
        if (!fromQu) { manual.push({ ...r, why: `ukendt enhed "${r.unit}"` }); continue; }

        const factor = findConversionFactor(conversions, r.product_id, fromQu, p.qu_id_stock);
        if (factor === null) {
            manual.push({ ...r, why: `ingen konvertering ${r.unit} → ${stockName}` });
            continue;
        }
        planned.push({ ...r, stockName, newAmount: r.packed_amount * factor, factor });
    }

    console.log(`\n${rows.length} række(r) i prep_packing_overrides\n`);

    if (planned.length) {
        console.log('KONVERTERES:');
        for (const p of planned) {
            const note = p.packed_amount === 0 ? '  (0 — kun enheden rettes)' : '';
            console.log(`  bon ${p.bon_id}  ${String(p.product_name || p.product_id).padEnd(20)} `
                + `${p.packed_amount} ${p.unit}  →  ${Math.round(p.newAmount * 10000) / 10000} ${p.stockName}${note}`);
        }
        console.log();
    }
    if (skipped.length) {
        console.log(`ALLEREDE I LAGER-ENHED (røres ikke): ${skipped.length}`);
        for (const s of skipped) {
            console.log(`  bon ${s.bon_id}  ${String(s.product_name || s.product_id).padEnd(20)} ${s.packed_amount} ${s.unit}`);
        }
        console.log();
    }
    if (manual.length) {
        console.log('KRÆVER MANUEL STILLINGTAGEN:');
        for (const m of manual) {
            console.log(`  bon ${m.bon_id}  ${String(m.product_name || m.product_id).padEnd(20)} `
                + `${m.packed_amount} ${m.unit || '(ingen enhed)'}  — ${m.why}`);
        }
        console.log();
    }

    if (!APPLY) {
        console.log(planned.length
            ? `Dry-run. Kør med --apply for at skrive ${planned.length} ændring(er).`
            : 'Dry-run. Intet at ændre.');
        return;
    }
    if (!planned.length) { console.log('Intet at skrive.'); return; }

    const upd = db.prepare(`UPDATE prep_packing_overrides SET packed_amount = ?, unit = ? WHERE rowid = ?`);
    for (const p of planned) upd.run(p.newAmount, p.stockName, p.rid);
    console.log(`✓ ${planned.length} række(r) konverteret til lager-enhed.`);
})().catch(e => { console.error('FEJL:', e.message); process.exit(1); });
