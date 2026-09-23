// scripts/test-web-order-lines-e2e.js
// ============================================================
// Integrationstest for #382 — rammer den ÆGTE DB-sti (createBon → INSERT
// bon_lines → recalcBonTotal), men isoleret i en engangs-kopi af dev-DB'en og
// med grocyAdapter.getRecipes stubbet (Grocy er ikke tilgængelig i alle miljøer).
//
// Beviser det unit-testen ikke kan: at linjerne rent faktisk lander i bon_lines
// med rigtige kolonner, og at bons.total_price genberegnes server-autoritativt.
//
// Kør:
//   node scripts/test-web-order-lines-e2e.js
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ── Isolér: .backup-kopi af dev-DB til scratch, peg DB_PATH derhen FØR db/database loades ──
const SRC = path.join(__dirname, '..', 'data', 'bon.db');
const TMP = path.join(__dirname, '..', 'data', `_test_weborder_${process.pid}.db`);
if (!fs.existsSync(SRC)) { console.error('Mangler data/bon.db — kør npm run dev-admin først'); process.exit(1); }
execFileSync('sqlite3', [SRC, `.backup '${TMP}'`]);   // WAL-sikker kopi
process.env.DB_PATH = TMP;
process.env.NODE_ENV = 'test';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

function cleanup() { for (const f of [TMP, TMP + '-wal', TMP + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} } }

(async () => {
  try {
    const { getDb } = require('../db/database');
    const { createBon } = require('../db/helpers');
    const grocy = require('../services/grocyAdapter');
    const webOrders = require('../routes/web-orders');

    // Stub Grocy — synthetiske opskrifter der matcher menu_items-id'erne nedenfor
    grocy.getRecipes = async () => ([
      { id: 91, name: 'Falaflen', category: '01 Sandwich', unit: 'stk',
        prices: { store: 90, catering: 94, festival: 98, produktion: 0, waiste: 0 }, cost_price: 23.55, co2e: 0.42 },
      { id: 77, name: 'Tunen', category: '01 Sandwich', unit: 'stk',
        prices: { store: 90, catering: 94, festival: 98, produktion: 0, waiste: 0 }, cost_price: 20, co2e: 0.5 },
      { id: 75, name: 'Glutenfri Bolle', category: 'Tilbehør & Bokse', unit: 'stk',
        prices: { store: 15, catering: 15, festival: 15, produktion: 0, waiste: 0 }, cost_price: 6, co2e: 0.1 },
    ]);

    const db = getDb();

    console.log('\n#382 — web-order auto-linjer (ægte DB-sti, isoleret)\n');

    // ── Opret en syntetisk web-order-bon (catering som default) ──
    const { bonId } = createBon({
      delivery_date: '2026-12-24', delivery_time: '11:00', delivery_type: 'delivery',
      pax: 40, customer_wishes: 'TEST #382', changelog_field: 'web_order',
      changelog_message: 'test', broadcast_extra: { source: 'web_order' },
    });
    ok(Number.isInteger(bonId) && bonId > 0, `bon oprettet (id=${bonId})`);

    const before = db.prepare('SELECT COUNT(*) AS n FROM bon_lines WHERE bon_id=?').get(bonId).n;
    ok(before === 0, 'bon starter uden linjer');

    // ── Kør auto-genereringen (den rigtige funktion fra web-orders.js) ──
    await webOrders._generateLinesFromMenuItems(db, bonId, {
      menu_items: [{ id: 'r91', count: 12 }, { id: 'r77', count: 8 }, { id: 'r91', count: 0 }],
      _form_meta: { menu_id: 'standard' },
    });

    const lines = db.prepare('SELECT * FROM bon_lines WHERE bon_id=? ORDER BY sort_order').all(bonId);
    ok(lines.length === 2, `2 linjer indsat (count=0 sprunget over) — fik ${lines.length}`);

    const fal = lines.find(l => l.grocy_recipe_id === 91);
    ok(fal && fal.quantity === 12, 'Falaflen: antal 12');
    ok(fal && fal.unit_price === 94, 'Falaflen: catering-pris 94 snapshottet');
    ok(fal && fal.line_total === 12 * 94, `Falaflen: line_total ${12 * 94}`);
    ok(fal && fal.product_name === 'Falaflen' && fal.category === '01 Sandwich', 'Falaflen: navn+kategori fra Grocy');
    ok(fal && Math.abs(fal.co2e - 0.42) < 1e-9, 'Falaflen: CO₂ snapshottet');

    // ── total_price genberegnet server-autoritativt ──
    const bon = db.prepare('SELECT total_price FROM bons WHERE id=?').get(bonId);
    const forventet = 12 * 94 + 8 * 94;
    ok(Math.abs(bon.total_price - forventet) < 1e-6, `total_price = ${forventet} (fik ${bon.total_price})`);

    // ── total_units genberegnet boks-aware ──
    // Forventet beregnes dynamisk fra recipe_unit_counts i kopien (en slider-boks
    // kan tælle som fx 3 enheder), så testen er datauafhængig og faktisk beviser
    // at recalcBonTotalUnits kørte med boks-udvidelsen.
    const ucOf = (rid) => {
      const r = db.prepare('SELECT unit_count FROM recipe_unit_counts WHERE grocy_recipe_id=?').get(rid);
      const uc = r ? Number(r.unit_count) : 0;
      return uc >= 2 ? uc : 1;
    };
    const forventetUnits = 12 * ucOf(91) + 8 * ucOf(77);
    const units = db.prepare('SELECT total_units FROM bons WHERE id=?').get(bonId).total_units;
    ok(units === forventetUnits, `total_units = ${forventetUnits} (boks-aware, fik ${units})`);

    // ── changelog-spor skrevet ──
    const cl = db.prepare("SELECT COUNT(*) AS n FROM changelog WHERE entity_type='bon' AND entity_id=? AND field_name='bon_lines'").get(bonId).n;
    ok(cl >= 1, 'changelog-spor for linje-tilføjelse');

    // ── Idempotens-agtigt: tom menu_items rører ikke bonen ──
    await webOrders._generateLinesFromMenuItems(db, bonId, { menu_items: [] });
    const after = db.prepare('SELECT COUNT(*) AS n FROM bon_lines WHERE bon_id=?').get(bonId).n;
    ok(after === 2, 'tom menu_items tilføjer ingen linjer');

    // ── Kost-knap: "Glutenfri: 2" i kundeønskerne → 2 glutenfri boller (B4314) ──
    const setting = db.prepare("SELECT value FROM settings WHERE key='bestilling.chip_recipes'").get();
    ok(setting && JSON.parse(setting.value).Glutenfri === 75, 'migration 189 seedet Glutenfri → 75');
    const { bonId: gfBon } = createBon({
      delivery_date: '2026-12-24', delivery_time: '11:00', delivery_type: 'delivery',
      pax: 14, customer_wishes: 'TEST glutenfri', changelog_field: 'web_order',
      changelog_message: 'test', broadcast_extra: { source: 'web_order' },
    });
    await webOrders._generateLinesFromMenuItems(db, gfBon, {
      wishes: 'Glutenfri: 2\n\n--- Valgte Menu ---\n12× Falaflen',
      menu_items: [{ id: 'r91', count: 12 }],
    });
    const gf = db.prepare('SELECT * FROM bon_lines WHERE bon_id=? AND grocy_recipe_id=75').all(gfBon);
    ok(gf.length === 1 && gf[0].quantity === 2 && gf[0].unit_price === 15, 'glutenfri bolle ×2 à 15 kr lagt på');

    // Kunden har selv valgt bollen i menuen → hendes antal gælder, ingen dublet
    const { bonId: gfBon2 } = createBon({
      delivery_date: '2026-12-24', delivery_time: '11:00', delivery_type: 'delivery',
      pax: 14, customer_wishes: 'TEST glutenfri 2', changelog_field: 'web_order',
      changelog_message: 'test', broadcast_extra: { source: 'web_order' },
    });
    await webOrders._generateLinesFromMenuItems(db, gfBon2, {
      wishes: 'Glutenfri: 2', menu_items: [{ id: 'r75', count: 5 }],
    });
    const gf2 = db.prepare('SELECT SUM(quantity) q FROM bon_lines WHERE bon_id=? AND grocy_recipe_id=75').get(gfBon2);
    ok(gf2.q === 5, `menuvalget vinder over knappen (5, fik ${gf2.q})`);

    // Kun knappen, ingen menu_items → linjen kommer stadig
    const { bonId: gfBon3 } = createBon({
      delivery_date: '2026-12-24', delivery_time: '11:00', delivery_type: 'delivery',
      pax: 14, customer_wishes: 'TEST glutenfri 3', changelog_field: 'web_order',
      changelog_message: 'test', broadcast_extra: { source: 'web_order' },
    });
    await webOrders._generateLinesFromMenuItems(db, gfBon3, { wishes: '14 stk, Glutenfri: 1\nGlutenfri: 1' });
    const gf3 = db.prepare('SELECT SUM(quantity) q FROM bon_lines WHERE bon_id=? AND grocy_recipe_id=75').get(gfBon3);
    ok(gf3.q === 1, `uden menuvalg: knappen alene giver en linje (fik ${gf3.q})`);

    console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} PASS · ${fail} FAIL\x1b[0m\n`);
  } catch (e) {
    console.error('\x1b[31mFEJL:\x1b[0m', e);
    fail++;
  } finally {
    cleanup();
  }
  process.exit(fail === 0 ? 0 : 1);
})();
