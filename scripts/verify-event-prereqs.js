// scripts/verify-event-prereqs.js
//
// Verificér forudsætningerne for Event-modulet (docs/CLAUDE_EVENT.md) FØR kode.
// Tjekker de tre §11-blokkere + to ting fundet ved kodeverifikation:
//   B1  inventory_auto_deduct slået til?           (§11.1 — ellers trækker prep-bon intet)
//   B2  hvor lander deduct_inventory-triggeren?    (§11.2 — gaten skal hænges præcist)
//   B3  findes en 'produktion'-priskategori?       (§11.3 — generatoren skal resolve den)
//   X1  price_category-dualitet (FK vs TEXT)        (gaten skal bruge FK→code, ikke TEXT)
//   X2  er migrationsfladen ren? (events/event_id)  (migration kan oprettes uden konflikt)
//
// Read-only. Ændrer intet. Kør mod den DB du vil verificere:
//   node --experimental-sqlite scripts/verify-event-prereqs.js
//   DB_PATH=/home/leif/bon-v2/data/bon.db node --experimental-sqlite scripts/verify-event-prereqs.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { openDb } = require('../db/compat');

const DB_PATH = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(__dirname, '..', 'data', 'bon.db');

if (!fs.existsSync(DB_PATH)) {
    console.error(`DB ikke fundet: ${DB_PATH}`);
    process.exit(1);
}

const db = openDb(DB_PATH);

const GREEN = '\x1b[32m', RED = '\x1b[31m', YEL = '\x1b[33m', DIM = '\x1b[2m', RST = '\x1b[0m';
const ok   = (m) => console.log(`  ${GREEN}✓${RST} ${m}`);
const bad  = (m) => console.log(`  ${RED}✗${RST} ${m}`);
const warn = (m) => console.log(`  ${YEL}!${RST} ${m}`);
const note = (m) => console.log(`    ${DIM}${m}${RST}`);

const blockers = [];   // ting der MÅ være grønne før go-live
function header(t) { console.log(`\n${t}`); }

function tableHasColumn(table, col) {
    try {
        return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
    } catch { return false; }
}
function tableExists(name) {
    return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

console.log(`\nEvent-modul — forudsætningstjek`);
console.log(`DB: ${DB_PATH}`);

// ── B1: inventory_auto_deduct ──────────────────────────────────────────────
header('B1 · inventory_auto_deduct (§11.1) — trækker prep-bon lager ved LEVERET?');
{
    const row = db.prepare(`SELECT value FROM settings WHERE key='inventory_auto_deduct'`).get();
    if (!row) {
        bad(`settingen findes ikke i settings-tabellen`);
        note(`autoConsumeBonInventory() returnerer tidligt når flaget ikke er '1' → prep-bon trækker INTET.`);
        blockers.push('B1: inventory_auto_deduct mangler/ikke sat');
    } else if (row.value === '1') {
        ok(`= '1' — prep-/top-up-bonner trækker HQ-lager ved LEVERET. Event-sporingen virker.`);
    } else {
        bad(`= '${row.value}' — auto-deduct er SLÅET FRA.`);
        note(`Prep-bonnen trækker ikke ved LEVERET → HQ-lager driver ikke. Skal sættes '1' før event-modulet virker.`);
        blockers.push(`B1: inventory_auto_deduct='${row.value}' (skal være '1')`);
    }
}

// ── B2: hvor lander deduct-triggeren ───────────────────────────────────────
header('B2 · deduct-sti (§11.2) — hvilke transitions har deduct_inventory-trigger?');
{
    // Kode-fakta (verificeret): autoConsumeBonInventory(id) kaldes KUN ved
    // status_code === 'LEVERET' i routes/bons.js. POS→BETALT findes ikke endnu.
    note(`Kode: autoConsumeBonInventory kaldes kun på LEVERET (routes/bons.js) + courier-levering (routes/delivery.js).`);
    const rows = db.prepare(`
        SELECT f.code AS from_code, t.code AS to_code, tr.triggers_json
        FROM status_transitions tr
        JOIN status_definitions f ON tr.from_status_id = f.id
        JOIN status_definitions t ON tr.to_status_id   = t.id
        WHERE tr.triggers_json LIKE '%deduct_inventory%'
    `).all();
    if (rows.length === 0) {
        warn(`ingen transition har 'deduct_inventory' i triggers_json.`);
        note(`Trækket sker uafhængigt af triggers_json (hårdkodet på LEVERET i koden) — dette er info, ikke en blokker.`);
    } else {
        rows.forEach(r => ok(`${r.from_code} → ${r.to_code}: ${r.triggers_json}`));
    }
    // Bekræft at BETALT IKKE har en deduct-sti (event-salgsbon → BETALT må ikke trække)
    const betaltDeduct = rows.some(r => r.to_code === 'BETALT');
    if (betaltDeduct) {
        warn(`BETALT har en deduct-trigger — event-salgsbon (→ BETALT) ville trække. No-deduct-gaten BLIVER nødvendig.`);
    } else {
        ok(`BETALT har ingen deduct-sti → event-salgsbon til BETALT trækker aldrig (gaten er fremtidssikring mod Zettle).`);
    }
}

// ── B3: produktion-priskategori ────────────────────────────────────────────
header("B3 · 'produktion'-priskategori (§11.3) — kan generatoren oprette prep-bon?");
let produktionPcId = null;
{
    const pc = db.prepare(`SELECT id, code, label, is_active FROM price_categories WHERE code='produktion'`).get();
    if (!pc) {
        bad(`ingen række med code='produktion' i price_categories.`);
        note(`POST /api/bons skriver price_category_id — uden rækken kan prep-bonnen ikke oprettes som produktion.`);
        blockers.push("B3: price_categories mangler 'produktion'-række");
    } else {
        produktionPcId = pc.id;
        if (pc.is_active === 1) ok(`findes: id=${pc.id}, label='${pc.label}', aktiv.`);
        else { warn(`findes (id=${pc.id}, '${pc.label}') men is_active=0.`); blockers.push("B3: 'produktion' is_active=0"); }
    }
    console.log(`    ${DIM}Alle priskategorier:${RST}`);
    db.prepare(`SELECT id, code, label, is_active FROM price_categories ORDER BY id`).all()
      .forEach(p => note(`  id=${p.id}  ${p.code}  '${p.label}'  ${p.is_active ? 'aktiv' : 'INAKTIV'}`));
}

// ── X1: price_category-dualitet ────────────────────────────────────────────
header('X1 · price_category-dualitet — gaten skal bruge FK→code, ikke TEXT-kolonnen');
{
    const hasFk   = tableHasColumn('bons', 'price_category_id');
    const hasText = tableHasColumn('bons', 'price_category');
    if (hasFk)   ok(`bons.price_category_id (FK) findes — POST/PATCH skriver denne.`);
    else         bad(`bons.price_category_id mangler (uventet).`);
    if (hasText) {
        warn(`bons.price_category (TEXT, migration 008) findes også — denormaliseret, skrives IKKE ved nye bons.`);
        // Mål hvor stale TEXT-kolonnen er ift. FK→code
        const mismatch = db.prepare(`
            SELECT COUNT(*) AS n FROM bons b
            LEFT JOIN price_categories pc ON b.price_category_id = pc.id
            WHERE b.price_category_id IS NOT NULL
              AND COALESCE(b.price_category,'') <> COALESCE(pc.code,'')
        `).get().n;
        if (mismatch > 0) {
            warn(`${mismatch} bons hvor TEXT-kolonnen ≠ FK→code → TEXT er stale. Gaten SKAL bruge price_category_code (join).`);
        } else {
            ok(`TEXT-kolonnen matcher FK→code på alle bons lige nu — men stol stadig på FK i gaten.`);
        }
    } else {
        ok(`ingen løs TEXT-kolonne — kun FK. Entydigt.`);
    }
    if (produktionPcId != null) {
        const cnt = db.prepare(`SELECT COUNT(*) AS n FROM bons WHERE price_category_id=?`).get(produktionPcId).n;
        note(`Eksisterende bons med price_category_id=${produktionPcId} (produktion): ${cnt}`);
    }
}

// ── X2: migrationsflade ────────────────────────────────────────────────────
header('X2 · migrationsflade — kan events-tabel + event_id oprettes rent?');
{
    if (tableExists('events')) { bad(`tabellen 'events' findes allerede — navnekonflikt.`); blockers.push('X2: events-tabel findes'); }
    else ok(`ingen 'events'-tabel — fri.`);

    if (tableHasColumn('bons', 'event_id')) { bad(`bons.event_id findes allerede — kolonnekonflikt.`); blockers.push('X2: bons.event_id findes'); }
    else ok(`ingen bons.event_id — fri.`);

    // Næste ledige migrationsnummer (advar ved eksisterende kollisioner)
    const dir = path.join(__dirname, '..', 'db', 'migrations');
    const nums = fs.readdirSync(dir).map(f => (f.match(/^(\d{3})_/) || [])[1]).filter(Boolean);
    const seen = {}, dupes = new Set();
    nums.forEach(n => { if (seen[n]) dupes.add(n); seen[n] = true; });
    const max = Math.max(...nums.map(Number));
    ok(`højeste migrationsnummer: ${String(max).padStart(3,'0')} → næste ledige: ${String(max+1).padStart(3,'0')}_events.sql`);
    if (dupes.size) warn(`bemærk eksisterende nummerkollisioner: ${[...dupes].join(', ')} (påvirker ikke event-migrationen).`);
}

// ── Sammenfatning ──────────────────────────────────────────────────────────
header('─────────────────────────────────────────────────────────────');
if (blockers.length === 0) {
    console.log(`${GREEN}ALT GRØNT${RST} — forudsætningerne er på plads. Klar til migration + gate.`);
} else {
    console.log(`${RED}${blockers.length} BLOKKER(E)${RST} skal løses før go-live:`);
    blockers.forEach(b => console.log(`  ${RED}•${RST} ${b}`));
}
console.log('');
db.close();
