// scripts/dry-run-consume.js
// ============================================================
// Tør-kørsel: hvad ville LEVERET trække fra Grocy, hvis lagertrækket var tændt?
//
// Baggrund (#305): inventory_auto_deduct står på '0', så LEVERET trækker intet.
// Før flaget tændes skal man vide om matematikken er sund — tændes det med
// skæve opskrifter eller manglende koblinger, får man negativt lager i stedet
// for styr på lageret.
//
// READ-ONLY. Der findes ingen --apply. Scriptet rører hverken Grocy eller basen.
//
// ── Hvad scriptet svarer på ─────────────────────────────────────────────────
//
// At tænde flaget trækker IKKE de gamle bons — de er fortid. Flaget rammer
// fremtiden. Så det interessante er ikke "hvad manglede der de sidste uger"
// (der går alt selvsagt i minus, fordi lageret er talt op siden), men:
//
//   1. DÆKNING  — bon-linjer uden grocy_recipe_id trækker INTET. Er en stor del
//                 af linjerne fritekst, tænder man flaget og tror lageret
//                 opdateres, mens det i stilhed står stille. Det er den samme
//                 fejlklasse som #305 selv: systemet regner videre uden at sige
//                 at det ikke ved noget.
//
//   2. REALISME — trækker en normal dags produktion et fornuftigt antal kilo,
//                 eller noget absurd? Absurde tal = fejl i BOM eller QU-
//                 konvertering, og de skal findes FØR flaget tændes.
//
// ── Brug ────────────────────────────────────────────────────────────────────
//
//   node --experimental-sqlite scripts/dry-run-consume.js                # sidste 7 dage
//   node --experimental-sqlite scripts/dry-run-consume.js --date=2026-08-02
//   node --experimental-sqlite scripts/dry-run-consume.js --from=... --to=...
//   node --experimental-sqlite scripts/dry-run-consume.js --all-statuses  # også ikke-leverede
//
// Kør mod den DB du vil undersøge:
//   DB_PATH=/home/leif/bon-v2/data/bon.db node --experimental-sqlite scripts/dry-run-consume.js
//
// EFTER en optælling: kør den over ÉN repræsentativ dag. Er trækket sundt og
// manglerne små, er lageret præcist nok til Vej A (CLAUDE_EVENT.md §11).
// Er der udbredte mangler, passer optællingen eller opskrifterne ikke — og så
// skal flaget ikke tændes endnu.
// ============================================================
'use strict';

const path = require('path');
const fs   = require('fs');

// Load .env FØR grocyAdapter requires — så GROCY_HQ_KEY o.l. er i miljøet når
// getGrocyConfig læser dem. Uden dette skulle scriptet køres med node's
// --env-file, hvilket er nemt at glemme; her virker et rent `node dry-run…`.
// Samme mønster som booking-reminders.js + check-inventory-deduct.js.
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
}

const { getDb } = require('../db/database');
const { todayISO, offsetISO } = require('../db/helpers');
const grocy = require('../services/grocyAdapter');

// ── Argumenter ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg = name => {
    const hit = args.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.split('=')[1] : null;
};
const has = name => args.includes(`--${name}`);

const single = arg('date');
const FROM = single || arg('from') || offsetISO(-7);
const TO   = single || arg('to')   || todayISO();
const ALL_STATUSES = has('all-statuses');

for (const [label, v] of [['from', FROM], ['to', TO]]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        console.error(`Ugyldig --${label}: "${v}" (forventer YYYY-MM-DD)`);
        process.exit(1);
    }
}

// ── Formattering ────────────────────────────────────────────────────────────
const C = { dim: '\x1b[2m', red: '\x1b[31m', yel: '\x1b[33m', grn: '\x1b[32m', bold: '\x1b[1m', off: '\x1b[0m' };
const num = n => (Math.round(n * 100) / 100).toLocaleString('da-DK');
const pad = (s, n) => String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const head = t => console.log(`\n${C.bold}${t}${C.off}`);

(async () => {
    const db = getDb();

    // ── Find kandidat-bons ──────────────────────────────────────────────────
    // Default: dem der HAR passeret LEVERET men ikke har trukket. Det er dem
    // flaget ville have ramt. --all-statuses tager alle bons i perioden, så man
    // også kan tør-køre et fremtidigt vindue (fx dagene op til et event).
    const statusFilter = ALL_STATUSES
        ? `AND sd.code != 'AFLYST'`
        : `AND sd.code IN ('LEVERET','FAKTURERET','BETALT','AFSLUTTET')`;

    const bons = db.prepare(`
        SELECT b.id, b.bon_number, b.delivery_date, b.inventory_deducted,
               sd.code AS status_code, pc.code AS price_category_code
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        LEFT JOIN price_categories pc ON b.price_category_id = pc.id
        WHERE b.delivery_date BETWEEN ? AND ?
          AND COALESCE(b.is_offer, 0) = 0
          ${statusFilter}
        ORDER BY b.delivery_date, b.id
    `).all(FROM, TO);

    console.log(`\n${C.bold}Tør-kørsel — hvad ville LEVERET trække fra Grocy?${C.off}`);
    console.log(`${C.dim}Periode: ${FROM} → ${TO}${single ? ' (én dag)' : ''}`);
    console.log(`Udvalg:  ${ALL_STATUSES ? 'alle bons (ekskl. aflyste)' : 'kun LEVERET og senere'}`);
    console.log(`READ-ONLY — hverken Grocy eller databasen røres.${C.off}`);

    const flag = db.prepare(`SELECT value FROM settings WHERE key='inventory_auto_deduct'`).get();
    console.log(`${C.dim}inventory_auto_deduct = '${flag?.value ?? '(ikke sat)'}'${C.off}`);

    if (!bons.length) {
        console.log(`\n${C.yel}Ingen bons i perioden. Prøv et andet interval eller --all-statuses.${C.off}\n`);
        process.exit(0);
    }

    const deducted = bons.filter(b => b.inventory_deducted === 1).length;
    console.log(`\nBons: ${bons.length}${deducted ? `  ${C.dim}(heraf ${deducted} har allerede trukket — de ville blive sprunget over)${C.off}` : ''}`);

    // ── 1) DÆKNING ──────────────────────────────────────────────────────────
    // Linjer uden grocy_recipe_id har ingen BOM og trækker derfor intet.
    const ids = bons.map(b => b.id);
    const ph = ids.map(() => '?').join(',');
    const lines = db.prepare(`
        SELECT bl.bon_id, bl.grocy_recipe_id, bl.product_name, bl.category, bl.quantity
        FROM bon_lines bl WHERE bl.bon_id IN (${ph})
    `).all(...ids);

    const withRecipe = lines.filter(l => l.grocy_recipe_id);
    const without    = lines.filter(l => !l.grocy_recipe_id);
    const pct = lines.length ? Math.round(withRecipe.length / lines.length * 100) : 0;

    head('1. DÆKNING — hvilke linjer ville overhovedet trække?');
    console.log(`   Linjer i alt:              ${lpad(lines.length, 5)}`);
    console.log(`   Med opskrift (trækker):    ${lpad(withRecipe.length, 5)}  ${pct >= 90 ? C.grn : C.yel}${pct}%${C.off}`);
    console.log(`   Uden opskrift (INTET):     ${lpad(without.length, 5)}`);

    if (without.length) {
        const byName = new Map();
        for (const l of without) {
            const k = l.product_name || '(uden navn)';
            byName.set(k, (byName.get(k) || 0) + 1);
        }
        const top = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
        console.log(`\n   ${C.dim}Disse trækker lydløst ingenting:${C.off}`);
        for (const [name, n] of top) console.log(`     ${C.dim}·${C.off} ${pad(name, 42)} ${lpad(n, 4)} linjer`);
        if (byName.size > top.length) console.log(`     ${C.dim}… og ${byName.size - top.length} andre${C.off}`);
        console.log(`\n   ${C.yel}Er noget herover en rigtig råvare, mangler den en opskriftskobling.${C.off}`);
        console.log(`   ${C.dim}Levering, service og gebyrer hører derimod IKKE på lageret — de er fine som de er.${C.off}`);
    }

    // ── 2) REALISME ─────────────────────────────────────────────────────────
    head('2. TRÆK PR. RÅVARE — er tallene sunde?');

    if (!withRecipe.length) {
        console.log(`   ${C.yel}Ingen linjer med opskrift — intet at beregne.${C.off}\n`);
        process.exit(0);
    }

    let plan;
    try {
        plan = await grocy.planConsume(withRecipe.map(l => ({
            grocy_recipe_id: l.grocy_recipe_id,
            quantity: l.quantity,
        })));
    } catch (err) {
        console.error(`\n   ${C.red}Kunne ikke nå Grocy: ${err.message}${C.off}`);
        console.error(`   ${C.dim}Dækningen ovenfor er stadig gyldig — den er ren SQL.${C.off}\n`);
        process.exit(1);
    }

    const items = plan.items || [];
    if (!items.length) {
        console.log(`   ${C.yel}Opskrifterne gav ingen råvarer. Mangler de ingredienser i Grocy?${C.off}\n`);
        process.exit(0);
    }

    const short = items.filter(i => i.shortfall > 0);
    const sorted = [...items].sort((a, b) => b.shortfall - a.shortfall || b.final_amount - a.final_amount);
    const show = sorted.slice(0, 25);

    // Kolonnebredder udledes af det bredeste tal — ellers støder lange mængder
    // ("1.813,63 Antal") ind i nabokolonnen og tabellen bliver ulæselig.
    const cell = (v, unit) => num(v) + (unit ? ' ' + unit : '');
    const W = Math.max(12, ...show.flatMap(i => [
        cell(i.final_amount, i.unit).length,
        cell(i.in_stock, i.unit).length,
        i.shortfall > 0 ? cell(i.shortfall, i.unit).length : 1,
    ])) + 2;

    console.log(`   ${C.dim}${pad('Vare', 32)}${lpad('Ville trække', W)}${lpad('På lager', W)}${lpad('Mangler', W)}${C.off}`);
    for (const i of show) {
        const col = i.shortfall > 0 ? C.red : C.off;
        console.log(
            `   ${pad(i.product_name, 32)}` +
            `${lpad(cell(i.final_amount, i.unit), W)}` +
            `${lpad(cell(i.in_stock, i.unit), W)}` +
            `${col}${lpad(i.shortfall > 0 ? cell(i.shortfall, i.unit) : '—', W)}${C.off}`
        );
    }
    if (items.length > show.length) console.log(`   ${C.dim}… og ${items.length - show.length} andre råvarer${C.off}`);

    // ── Sammenfatning ───────────────────────────────────────────────────────
    head('SAMMENFATNING');
    console.log(`   Råvarer der ville blive trukket:  ${lpad(items.length, 5)}`);
    console.log(`   Heraf der ville gå i minus:       ${lpad(short.length, 5)}  ${short.length ? C.red : C.grn}${short.length ? '⚠' : '✓'}${C.off}`);

    const histori = TO < todayISO();
    console.log();
    if (histori && !single) {
        console.log(`   ${C.dim}Bemærk: perioden ligger i fortiden. Mangler er FORVENTEDE — varerne er`);
        console.log(`   for længst spist, og lageret er talt op siden. Det siger intet om flaget.`);
        console.log(`   Kør med --date=<en repræsentativ dag> EFTER en optælling for det rigtige signal.${C.off}`);
    } else if (short.length) {
        console.log(`   ${C.yel}Udbredte mangler betyder ét af to: optællingen passer ikke, eller`);
        console.log(`   opskrifterne/enhederne gør ikke. Find ud af hvilket FØR flaget tændes —`);
        console.log(`   ellers bytter man et lager der står stille ud med et der går i minus.${C.off}`);
    } else {
        console.log(`   ${C.grn}Ingen mangler. Lageret ser præcist nok ud til Vej A (§11) for denne dag.${C.off}`);
    }
    console.log(`\n   ${C.dim}Intet blev ændret. Se #305 for rækkefølgen: tæl op → tør-kør → tænd flag → hold øje.${C.off}\n`);
})();
