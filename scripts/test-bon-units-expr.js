// scripts/test-bon-units-expr.js
//
// Integrationstest for det delte enheds-udtryk (db/helpers.bonUnitsExpr) mod en
// frisk temp-DB. Tester især ARKIV-ROBUSTHED: en slider hvis recipe er arkiveret
// (recipe_unit_counts.unit_count = 0) skal STADIG tælle via linjens snapshot-
// kategori — ellers undertæller historiske bons hver gang en opskrift arkiveres.
//
//   node --experimental-sqlite scripts/test-bon-units-expr.js

const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = path.join(os.tmpdir(), `bon-units-test-${process.pid}.db`);
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP + ext); } catch {} }
process.env.DB_PATH = TMP;

const { getDb } = require('../db/database');
const { bonUnitsExpr, recalcBonTotalUnits } = require('../db/helpers');

const db = getDb();                 // kører alle migrationer → fuldt skema
db.exec('PRAGMA foreign_keys = OFF'); // vi indsætter kun bon_lines + recipe_unit_counts

// Sæt en kendt whitelist + extra (uafhængigt af migration-defaults)
db.prepare(`INSERT INTO settings (key,value) VALUES ('unit_count_categories', ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run('["01 Sandwich","02 Salat","04 Slider"]');
db.prepare(`INSERT INTO settings (key,value) VALUES ('unit_count_extra_recipes', ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run('[71]');

// recipe_unit_counts: simulér Grocy-tilstand
const ruc = db.prepare(`INSERT INTO recipe_unit_counts (grocy_recipe_id, unit_count) VALUES (?,?)`);
ruc.run(101, 1);  // normal slider
ruc.run(102, 3);  // kombo-boks (3 sliders)
ruc.run(103, 0);  // ARKIVERET slider (grupper flyttet til "gamle opskrifter")
ruc.run(104, 0);  // emballage
ruc.run(105, 1);  // grocy siger tællende (fanger fejl-kategoriseret snapshot)
ruc.run(106, 0);  // brød i "Tilbehør & Bokse" (ikke tællende)
// recipe 71 (Børne Boks) bevidst UDEN ruc-række → testes via extra-listen

const BON = 9999;
const ins = db.prepare(`INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, category, quantity, is_accessory)
                        VALUES (?,?,?,?,?,?)`);
//      bon  recipe  navn               kategori(SNAPSHOT)    qty  acc   → forventet bidrag
ins.run(BON, 101, 'Slider',            '04 Slider',          5, 0); //  5  (normal)
ins.run(BON, 102, 'Slider Boks',       '04 Slider',          2, 0); //  6  (boks ×3)
ins.run(BON, 103, 'Arkiveret Slider',  '04 Slider',          4, 0); //  4  (ARKIV-CASE — gammel logik gav 0)
ins.run(BON, 104, 'RR Boks',           '06 Emballage',      10, 0); //  0  (emballage)
ins.run(BON, 105, 'Fejlkat sandwich',  'lunch',              3, 0); //  3  (grocy siger tællende)
ins.run(BON,  71, 'Børne Boks',        'Tilbehør & Bokse',   2, 0); //  2  (extra-liste)
ins.run(BON, 106, 'Glutenfri Bolle',   'Tilbehør & Bokse',   9, 0); //  0  (ikke tællende)
ins.run(BON, 101, 'Slider (tilbehør)', '04 Slider',        100, 1); //  0  (is_accessory)
const EXPECTED = 5 + 6 + 4 + 0 + 3 + 2 + 0 + 0; // = 20

let pass = 0, fail = 0;
function check(label, got, want) { const ok = got === want; console.log(`${ok ? '✓' : '✗'} ${label}: ${got} (forventet ${want})`); ok ? pass++ : fail++; }

// 1) Kør det DELTE udtryk direkte (samme SQL som drift bruger)
const { contrib, join, args } = bonUnitsExpr();
const got = db.prepare(`
  SELECT COALESCE(SUM(${contrib}), 0) AS t
  FROM bon_lines bl ${join}
  WHERE bl.bon_id = ? AND (bl.is_accessory = 0 OR bl.is_accessory IS NULL)
`).get(...args, BON).t;
check('bonUnitsExpr total', got, EXPECTED);

// 2) Den arkiverede slider (recipe 103) tæller 4, ikke 0
const arch = db.prepare(`
  SELECT COALESCE(SUM(${contrib}), 0) AS t
  FROM bon_lines bl ${join}
  WHERE bl.bon_id = ? AND bl.grocy_recipe_id = 103
`).get(...args, BON).t;
check('arkiveret slider (103) tæller via snapshot', arch, 4);

// 3) recalcBonTotalUnits skriver samme tal (kræver en bons-række)
db.prepare(`INSERT INTO bons (id, bon_number, status_id, location_id, order_date, delivery_date) VALUES (?,?,?,?,?,?)`)
  .run(BON, 'T-UNITS', 1, 1, '2026-01-01', '2026-01-01');
check('recalcBonTotalUnits', recalcBonTotalUnits(db, BON), EXPECTED);

for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP + ext); } catch {} }
console.log(`\n${fail === 0 ? '✅ ALLE' : '❌'} — ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
