// scripts/prep-estimate.js
//
// PROTOTYPE — prep-time-estimat for et event (CLAUDE_EVENT.md §15).
//
// Formål: vise TALLENE bag prep-tid-modellen FØR vi beslutter hjemsted for
// prep-tider (Grocy-userfield vs. lokal tabel) og granularitet (kategori vs.
// opskrift). Dette er en ENGANGS-beregner, ikke wired ind i noget: ingen tabel,
// ingen migration, ingen route, ingen UI. Rater ligger i RATES-blokken nedenfor
// og er ment til at blive rettet i hånden mens vi kalibrerer.
//
// Model (§15.1): prep deler sig i TO former —
//   per-enhed  = Σ(forecast-enheder × min/enhed)   (skalerer med festivalstørrelse)
//   per-batch  = Σ(faste batch-timer)              (~uafhængig af mængde)
//   prep-timer = per-enhed + per-batch
//
// Ærlighed (§15.4): flere rater er UKENDT (kartofler, purløg). De rapporteres
// som eksplicitte HULLER, ikke som 0 — så totalen ærligt er en NEDRE grænse.
//
// Brug:
//   node scripts/prep-estimate.js --sandwich 500 --slider 300 --salat 120 \
//        --sylt-slags 3 --dressing-kg 8 --frikadeller 400 --kartofler --purloeg
//
//   node --experimental-sqlite scripts/prep-estimate.js --db data/bon.db --event 12
//        (summerer event_forecast pr. kategori + bruger events.start_date)
//
// Bemandings-antagelser (til "start-senest"-forslaget) kan sættes:
//   --crew 2 --hours-per-day 6 --window 0
//
// ────────────────────────────────────────────────────────────────────────────

'use strict';

// ══════════════════════════════════════════════════════════════════════════
// RATES — §15.2 (Leif, juli 2026, ca.-tal). RET FRIT mens vi kalibrerer.
// ══════════════════════════════════════════════════════════════════════════

// PER-ENHED: min pr. FÆRDIG-enhed, nøglet på forecast-kategori.
// Dækker pt. KUN brød-skæring (det eneste der mapper rent til en forecast-kat).
// Salat/kager/drikke har ingen registreret skæretid → ikke med her.
const PER_UNIT_MIN = {
  '01 Sandwich': 15 / 64,   // 1 kasse = 64 emner / 15 min ≈ 0.234 min (~14 sek)
  '04 Slider':   40 / 128,  // 1 kasse = 128 slidere / 40 min = 0.3125 min (~19 sek)
  // '02 Salat': ukendt — ingen skæretid registreret
};

// KOMPONENT-STEPS (per-enhed men på en KOMPONENT, ikke en forecast-kat).
// Antallet kommer ikke fra forecasten uden BOM — indtastes manuelt som flag
// indtil vi evt. binder dem til opskriftstræet.
const COMPONENT_MIN = {
  frikadeller: 15 / 100,    // 100 stk / 15 min = 0.15 min/stk  (flag: --frikadeller N)
};

// Ingen ukendte rater tilbage — kartofler + purløg fik tal (Leif, juli 2026)
// og ligger nu som faste batch-opgaver i BATCH nedenfor (enhed uafklaret, se note).
const UNKNOWN_COMPONENTS = {};

// PER-BATCH: faste timer, ~uafhængige af mængde.
const BATCH = {
  sylt_hours_per_slags: 2,   // ~2 t pr. slags sylt (flag: --sylt-slags N, typisk 3)
  dressing_min_per_kg:  5,   // 10 min / 2 kg = 5 min/kg (flag: --dressing-kg N)
  // Kartofler + purløg: Leif gav "ca 15 min" / "ca 10 min" UDEN enhed. 15 min pr. kg
  // ville være urealistisk stort → tolket som FASTE batch-opgaver (som sylt: én kort
  // opgave uanset mængde). ⚠️ Enheden skal verificeres ved kalibrering — se
  // docs/CLAUDE_EVENT.md §15.2. Slås til/fra med --kartofler / --purloeg (boolean-flag).
  kartofler_fixed_min: 15,   // fast, hvis eventet skærer kartofler (flag: --kartofler)
  purloeg_fixed_min:   10,   // fast, hvis eventet snitter purløg   (flag: --purloeg)
};

// ══════════════════════════════════════════════════════════════════════════

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { a[key] = true; }
      else { a[key] = next; i++; }
    }
  }
  return a;
}

function num(v, dflt = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

function fmtH(minutes) {
  const h = minutes / 60;
  return `${h.toFixed(2)} t (${Math.round(minutes)} min)`;
}

// Læs forecast-mængder pr. kategori fra en DB (valgfrit).
function readFromDb(dbPath, eventId) {
  const { openDb } = require('../db/compat.js');
  const db = openDb(dbPath);
  const ev = db.prepare('SELECT id, name, start_date FROM events WHERE id = ?').get(eventId);
  if (!ev) { throw new Error(`Event ${eventId} findes ikke i ${dbPath}`); }
  const rows = db.prepare(
    `SELECT category, SUM(expected_qty) AS qty
       FROM event_forecast WHERE event_id = ? GROUP BY category`
  ).all(eventId);
  const byCat = {};
  for (const r of rows) byCat[r.category] = r.qty;
  return { event: ev, byCat };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // ── Indhent forecast-mængder pr. kategori ──
  let byCat = {};
  let eventInfo = null;
  if (args.db && args.event) {
    const res = readFromDb(String(args.db), parseInt(args.event, 10));
    byCat = res.byCat;
    eventInfo = res.event;
  } else {
    // ad-hoc flags → map til de kanoniske forecast-kategorier
    if (args.sandwich) byCat['01 Sandwich'] = num(args.sandwich);
    if (args.slider)   byCat['04 Slider']   = num(args.slider);
    if (args.salat)    byCat['02 Salat']    = num(args.salat);
  }

  const crew        = num(args.crew, 2);
  const hoursPerDay = num(args['hours-per-day'], 6);

  // ── 1) Per-enhed (brød-skæring pr. kategori) ──
  const perUnitLines = [];
  let perUnitMin = 0;
  const gaps = [];
  for (const [cat, qty] of Object.entries(byCat)) {
    const rate = PER_UNIT_MIN[cat];
    if (rate === undefined) {
      if (qty > 0) gaps.push(`Per-enhed: kategori "${cat}" (${qty} enh) har ingen registreret prep-rate`);
      continue;
    }
    const min = qty * rate;
    perUnitMin += min;
    perUnitLines.push({ label: `Skære brød — ${cat}`, detail: `${qty} × ${rate.toFixed(3)} min`, min });
  }

  // ── 2) Komponent-steps (per-enhed på komponent, mængde via flag) ──
  const compLines = [];
  let compMin = 0;
  if (args.frikadeller) {
    const qty = num(args.frikadeller);
    const min = qty * COMPONENT_MIN.frikadeller;
    compMin += min;
    compLines.push({ label: 'Skære frikadeller', detail: `${qty} × ${COMPONENT_MIN.frikadeller} min`, min });
  }
  for (const info of Object.values(UNKNOWN_COMPONENTS)) {
    if (args[info.flag]) gaps.push(`${info.label}: ${args[info.flag]} angivet, men ${info.note} → ikke medregnet`);
  }

  // ── 3) Per-batch (faste timer) ──
  const batchLines = [];
  let batchMin = 0;
  if (args['sylt-slags']) {
    const slags = num(args['sylt-slags']);
    const min = slags * BATCH.sylt_hours_per_slags * 60;
    batchMin += min;
    batchLines.push({ label: 'Sylt', detail: `${slags} slags × ${BATCH.sylt_hours_per_slags} t`, min });
  }
  if (args['dressing-kg']) {
    const kg = num(args['dressing-kg']);
    const min = kg * BATCH.dressing_min_per_kg;
    batchMin += min;
    batchLines.push({ label: 'Blande dressing/mayo', detail: `${kg} kg × ${BATCH.dressing_min_per_kg} min`, min });
  }
  // Kartofler + purløg: boolean-flag (laves eventet det, ja/nej) — faste tider,
  // enhed uafklaret (se BATCH-kommentar + §15.2). ⚠ i detaljen minder om det.
  if (args.kartofler) {
    batchMin += BATCH.kartofler_fixed_min;
    batchLines.push({ label: 'Skære kartofler', detail: `fast ${BATCH.kartofler_fixed_min} min ⚠`, min: BATCH.kartofler_fixed_min });
  }
  if (args.purloeg) {
    batchMin += BATCH.purloeg_fixed_min;
    batchLines.push({ label: 'Snitte purløg', detail: `fast ${BATCH.purloeg_fixed_min} min ⚠`, min: BATCH.purloeg_fixed_min });
  }

  const totalMin = perUnitMin + compMin + batchMin;
  const totalHours = totalMin / 60;

  // ── Output ──
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  PREP-TIME ESTIMAT (prototype — CLAUDE_EVENT.md §15)');
  if (eventInfo) console.log(`  Event: ${eventInfo.name} (id ${eventInfo.id}, start ${eventInfo.start_date})`);
  console.log('═══════════════════════════════════════════════════════════════');

  const printSection = (title, lines, subtotalMin) => {
    console.log(`\n▸ ${title}`);
    if (!lines.length) { console.log('    (ingen)'); return; }
    for (const l of lines) {
      console.log(`    ${l.label.padEnd(28)} ${l.detail.padEnd(22)} = ${fmtH(l.min)}`);
    }
    console.log(`    ${''.padEnd(28)} ${'SUBTOTAL'.padEnd(22)} = ${fmtH(subtotalMin)}`);
  };

  printSection('PER-ENHED (skalerer med størrelse)', perUnitLines, perUnitMin);
  printSection('KOMPONENT-STEPS (per-enhed på komponent)', compLines, compMin);
  printSection('PER-BATCH (fast tid)', batchLines, batchMin);

  console.log('\n───────────────────────────────────────────────────────────────');
  console.log(`  I ALT: ${fmtH(totalMin)}`);
  if (crew > 0 && hoursPerDay > 0) {
    const personDays = totalHours / hoursPerDay;
    const wallDays = Math.ceil(totalHours / (crew * hoursPerDay));
    console.log(`  ≈ ${personDays.toFixed(1)} person-dage  ·  ${wallDays} kalender-dag(e) med ${crew} personer á ${hoursPerDay} t`);
    if (eventInfo && eventInfo.start_date) {
      const start = new Date(eventInfo.start_date + 'T00:00:00');
      start.setDate(start.getDate() - wallDays);
      const y = start.getFullYear(), m = String(start.getMonth() + 1).padStart(2, '0'), d = String(start.getDate()).padStart(2, '0');
      console.log(`  → start prep SENEST: ${y}-${m}-${d} (${wallDays} dag(e) før event-start)`);
    }
  }

  if (gaps.length) {
    console.log('\n⚠ HULLER (totalen er en NEDRE grænse):');
    for (const g of gaps) console.log(`    · ${g}`);
  }
  console.log('');
  console.log('Bemærk: rater i RATES-blokken øverst i scriptet er §15.2 ca.-tal — ret dem og kør igen.');
  console.log('');
}

try { main(); }
catch (e) { console.error('Fejl:', e.message); process.exit(1); }
