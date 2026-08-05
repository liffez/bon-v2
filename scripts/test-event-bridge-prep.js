// scripts/test-event-bridge-prep.js
// ============================================================
// Fase 3-test: event-bro prep-endpoint (routes/event-bridge.js).
// Se docs/CLAUDE_EVENT_BON_BRIDGE.md.
//
// Kører mod en isoleret temp-DB in-process (migrations → getDb-singleton), så
// prod aldrig røres. Rammer den ÆGTE kerne applyPrepPush(db, …) — samme funktion
// route-handleren bruger — så find/opret/reconcile/frys testes rigtigt.
// resolvePrepLines testes separat med injicerede Grocy-mocks (ingen Grocy).
//
// Kør:  node --experimental-sqlite scripts/test-event-bridge-prep.js
// ============================================================

const path = require('path');
const os   = require('os');

const TEST_DB = path.join(os.tmpdir(), `bon-test-bridge-prep-${Date.now()}.db`);

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) { pass++; }
    else { fail++; console.error('  ✗ ' + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (fik ${JSON.stringify(a)}, ventede ${JSON.stringify(b)})`); }

// Grocy-mock til resolvePrepLines
const mockGrocy = {
    getRecipes: async () => [
        { id: 91, name: 'Grisen på Rug', category: '01 Sandwich', unit: 'stk', prices: { produktion: 0, festival: 115 }, cost_price: 23.5, co2e: 0.4 },
        { id: 92, name: 'Salaten',        category: '02 Salat',    unit: 'stk', prices: { produktion: 0, festival: 98 },  cost_price: 20 }
    ]
};

async function main() {
    process.env.DB_PATH = TEST_DB;
    process.env.NODE_ENV = 'test';
    const { runMigrations } = require('../db/migrate');
    runMigrations(TEST_DB);

    // Brug getDb-singleton som fælles handle — de interne helpers (nextBonNumber,
    // getStatusId, logChange) bruger også getDb(), så alt deler én forbindelse.
    const { getDb } = require('../db/database');
    const db = getDb();

    const { resolvePrepLines, applyPrepPush, findPrepBon, buildEventMenu } = require('../routes/event-bridge');

    const locId = db.prepare(`SELECT id FROM locations LIMIT 1`).get().id;
    const eventId = Number(db.prepare(`
        INSERT INTO events (name, location_id, model, start_date, end_date, status)
        VALUES ('Bro-test', ?, 'light', '2026-07-30', '2026-07-31', 'planning')
    `).run(locId).lastInsertRowid);
    const event = db.prepare(`SELECT id, name, location_id, event_address_id FROM events WHERE id = ?`).get(eventId);

    const DAY1 = '2026-07-30';
    const DAY2 = '2026-07-31';

    // ── resolvePrepLines: aggregat → linjer (mocket Grocy) ──────────────────
    const { lines: r1, unmatched: u1 } = await resolvePrepLines(
        [{ grocy_recipe_id: 91, antal: 12 }, { grocy_recipe_id: 92, antal: 5 }, { grocy_recipe_id: 999, antal: 3 }],
        mockGrocy
    );
    eq(r1.length, 2, 'resolvePrepLines: 2 linjer matchet');
    eq(u1.length, 1, 'resolvePrepLines: 1 unmatched (999)');
    const l91 = r1.find(l => l.grocy_recipe_id === 91);
    eq(l91.quantity, 12, 'resolvePrepLines: antal→quantity');
    eq(l91.product_name, 'Grisen på Rug', 'resolvePrepLines: navn snapshottet');
    eq(Number(l91.cost_price), 23.5, 'resolvePrepLines: kostpris snapshottet');
    ok(l91.unit_price === null || Number(l91.unit_price) === 0, 'resolvePrepLines: produktion-pris 0/null');

    // ── Broen må ALDRIG røre en prep-bon office selv har lavet (migration 136) ──
    // Regressionen fra drift: en forecast-bon på 133+133+133 blev reduceret til
    // "1 × Tunen" af én forudbestilling.
    const officeStatus = db.prepare(`SELECT id FROM status_definitions WHERE code='GODKENDT'`).get().id;
    const officePc = db.prepare(`SELECT id, code FROM price_categories WHERE code='produktion'`).get();
    const officeBonId = Number(db.prepare(`
        INSERT INTO bons (bon_number, status_id, location_id, price_category_id, price_category,
                          event_id, event_role, order_date, delivery_date, total_price, inventory_deducted)
        VALUES ('T-OFFICE', ?, ?, ?, 'produktion', ?, 'prep', '2026-07-01', ?, 0, 0)
    `).run(officeStatus, locId, officePc.id, eventId, DAY1).lastInsertRowid);
    db.prepare(`INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, category, quantity, unit, unit_price, line_total, sort_order)
                VALUES (?, 91, 'Forecast-vare', '01 Sandwich', 133, 'stk', 0, 0, 0)`).run(officeBonId);

    // ── applyPrepPush: OPRET (dag 1) ────────────────────────────────────────
    const c1 = applyPrepPush(db, { event, date: DAY1, resolved: r1 });
    eq(c1.action, 'created', 'push dag1 → created');
    ok(c1.bonId > 0 && typeof c1.bonNumber === 'string', 'push dag1 → bonId + bonNumber');
    ok(c1.bonId !== officeBonId, 'broen opretter SIN EGEN bon (ikke office\'s forecast-bon)');
    eq(Number(db.prepare(`SELECT quantity FROM bon_lines WHERE bon_id=?`).get(officeBonId).quantity), 133,
       'office\'s forecast-bon er URØRT (133 bevaret)');

    const bon1 = db.prepare(`SELECT b.*, sd.code AS status_code, pc.code AS pc_code FROM bons b JOIN status_definitions sd ON b.status_id=sd.id JOIN price_categories pc ON b.price_category_id=pc.id WHERE b.id=?`).get(c1.bonId);
    eq(bon1.event_id, eventId, 'bon dag1: event_id');
    eq(bon1.event_role, 'prep', 'bon dag1: event_role=prep');
    eq(bon1.delivery_date, DAY1, 'bon dag1: delivery_date');
    eq(bon1.pc_code, 'produktion', 'bon dag1: priskategori=produktion');
    eq(bon1.status_code, 'GODKENDT', 'bon dag1: status=GODKENDT');
    eq(Number(bon1.total_units), 17, 'bon dag1: total_units=17 (sandwich 12 + salat 5)');
    eq(db.prepare(`SELECT COUNT(*) n FROM bon_lines WHERE bon_id=?`).get(c1.bonId).n, 2, 'bon dag1: 2 linjer');

    // ── applyPrepPush: RECONCILE (samme dag, nye tal) ───────────────────────
    const { lines: r1b } = await resolvePrepLines([{ grocy_recipe_id: 91, antal: 20 }], mockGrocy);
    const c2 = applyPrepPush(db, { event, date: DAY1, resolved: r1b });
    eq(c2.action, 'updated', 'push dag1 igen → updated');
    eq(c2.bonId, c1.bonId, 'push dag1 igen → SAMME bon (ingen dublet)');
    eq(db.prepare(`SELECT COUNT(*) n FROM bon_lines WHERE bon_id=?`).get(c1.bonId).n, 1, 'reconcile: gamle linjer slettet, 1 tilbage');
    eq(Number(db.prepare(`SELECT quantity FROM bon_lines WHERE bon_id=?`).get(c1.bonId).quantity), 20, 'reconcile: ny mængde 20');
    eq(Number(db.prepare(`SELECT total_units FROM bons WHERE id=?`).get(c1.bonId).total_units), 20, 'reconcile: total_units genberegnet');
    eq(db.prepare(`SELECT COUNT(*) n FROM event_bridge_bons WHERE event_id=?`).get(eventId).n, 1, 'stadig kun 1 bro-bon efter reconcile');

    // ── applyPrepPush: DAG 2 → ny prep-bon under samme event ────────────────
    const { lines: r2 } = await resolvePrepLines([{ grocy_recipe_id: 92, antal: 8 }], mockGrocy);
    const c3 = applyPrepPush(db, { event, date: DAY2, resolved: r2 });
    eq(c3.action, 'created', 'push dag2 → created');
    ok(c3.bonId !== c1.bonId, 'push dag2 → ny bon (≠ dag1)');
    eq(db.prepare(`SELECT COUNT(*) n FROM event_bridge_bons WHERE event_id=?`).get(eventId).n, 2, '2 bro-bons (én pr. dag) under samme event');

    // ── FRYS: status IGANG → mutér ikke ─────────────────────────────────────
    db.prepare(`UPDATE bons SET status_id=(SELECT id FROM status_definitions WHERE code='IGANG') WHERE id=?`).run(c1.bonId);
    const beforeLines = db.prepare(`SELECT quantity FROM bon_lines WHERE bon_id=?`).get(c1.bonId).quantity;
    const { lines: r1c } = await resolvePrepLines([{ grocy_recipe_id: 91, antal: 99 }], mockGrocy);
    const c4 = applyPrepPush(db, { event, date: DAY1, resolved: r1c });
    eq(c4.action, 'frozen', 'IGANG → frozen');
    eq(c4.bonId, c1.bonId, 'frozen → returnerer den låste bon');
    eq(Number(db.prepare(`SELECT quantity FROM bon_lines WHERE bon_id=?`).get(c1.bonId).quantity), Number(beforeLines), 'frozen: linjer IKKE muteret');

    // ── FRYS: inventory_deducted=1 (selv i GODKENDT) → mutér ikke ───────────
    db.prepare(`UPDATE bons SET status_id=(SELECT id FROM status_definitions WHERE code='GODKENDT'), inventory_deducted=1 WHERE id=?`).run(c1.bonId);
    const c5 = applyPrepPush(db, { event, date: DAY1, resolved: r1c });
    eq(c5.action, 'frozen', 'inventory_deducted=1 → frozen (lager allerede trukket)');

    // ── AFLYST prep-bon ignoreres (ny oprettes) ─────────────────────────────
    db.prepare(`UPDATE bons SET status_id=(SELECT id FROM status_definitions WHERE code='AFLYST') WHERE id=?`).run(c3.bonId);
    ok(!findPrepBon(db, eventId, DAY2), 'AFLYST prep-bon findes ikke som aktiv');
    const c6 = applyPrepPush(db, { event, date: DAY2, resolved: r2 });
    eq(c6.action, 'created', 'AFLYST dag2 → ny prep-bon oprettes');

    // ── buildEventMenu: kurateret event-menu (kun 3 varer, event-priser) ────
    db.prepare(`INSERT INTO event_menu_items (event_id, grocy_recipe_id, product_name, category, unit_price, sort_order) VALUES (?,?,?,?,?,?)`).run(eventId, 91, 'Grisen på Rug', '01 Sandwich', 143, 1);
    db.prepare(`INSERT INTO event_menu_items (event_id, grocy_recipe_id, product_name, category, unit_price, sort_order) VALUES (?,?,?,?,?,?)`).run(eventId, 92, 'Salaten', '02 Salat', 99, 2);
    db.prepare(`INSERT INTO event_menu_items (event_id, grocy_recipe_id, product_name, category, unit_price, sort_order) VALUES (?,?,?,?,?,?)`).run(eventId, null, 'Fri-tekst ret', null, 50, 3);
    const em = buildEventMenu(db, eventId, 'standard');
    ok(em && em.source === 'event-menu', 'buildEventMenu: source=event-menu');
    eq(em.items.length, 3, 'event-menu: kun de 3 kuraterede varer (ikke hele Grocy)');
    eq(em.items[0].id, 'r91', 'event-menu: grocy-vare → r91');
    eq(em.items[0].price, 14300, 'event-menu: pris i øre (143 kr incl moms)');
    eq(em.items[1].price, 9900, 'event-menu: custom event-pris (99 kr, ≠ festival)');
    // Fritekst-id er navne-baseret (n<slug>), IKKE rækkens id: PUT er delete+insert,
    // så id'er skifter ved hver gemning og ville knække kurve + prep-tælling.
    eq(em.items[2].id, 'nfritekstret', 'event-menu: fri-tekst vare → stabilt n<slug>-id');
    ok(buildEventMenu(db, 999999) === null, 'event uden menu → null (fallback til Grocy)');

    // ── Tilvalg (migration 135): glutenfri bolle på ÉN af retterne ──────────
    db.prepare(`INSERT INTO event_menu_items (event_id, grocy_recipe_id, product_name, category, unit_price, sort_order, item_type, applies_to, note)
                VALUES (?,?,?,?,?,?,'option',?,?)`)
      .run(eventId, 161, 'Glutenfri Bolle', 'Tilbehør', 15, 4, JSON.stringify(['r:91']), 'Brødtype');
    const em2 = buildEventMenu(db, eventId, 'standard');
    eq(em2.items.length, 3, 'tilvalg vises IKKE som selvstændig ret (3 retter, ikke 4)');
    const tunen = em2.items.find(i => i.id === 'r91');
    const salat = em2.items.find(i => i.id === 'r92');
    eq(tunen.options.length, 1, 'r91 har tilvalgs-gruppe');
    eq(tunen.options[0].label, 'Brødtype', 'gruppe-label fra note');
    eq(tunen.options[0].choices.length, 2, 'to valg: Almindelig + tilvalg');
    eq(tunen.options[0].choices[0].price, 0, 'Almindelig koster 0 (forvalgt)');
    eq(tunen.options[0].choices[1].id, 'r161', 'tilvalgets choice-id bærer Grocy-id (prep kan tælle det)');
    eq(tunen.options[0].choices[1].price, 1500, 'tilvalg +15 kr i øre');
    eq(tunen.options[0].choices[1].tag, 'gluten-free', 'allergen-tag udledt af navnet');
    eq(salat.options.length, 0, 'r92 har INGEN tilvalg (kun der hvor det er hakket af)');
    ok(!tunen.options[0].id.includes('_'), 'gruppe-id uden _ (ellers kan choiceId ikke læses tilbage)');

    // Tilvalg uden applies_to → vises som almindelig ret (forsvinder ikke i stilhed)
    db.prepare(`UPDATE event_menu_items SET applies_to = NULL WHERE event_id = ? AND grocy_recipe_id = 161`).run(eventId);
    eq(buildEventMenu(db, eventId).items.length, 4, 'tilvalg uden retter → vises som ret (fallback)');

    // ── Allergener/tags/beskrivelse hentes fra bestillingsmenuen (samme kilde
    //    som bon-formularen), nøglet på recipe-id ────────────────────────────
    db.prepare(`INSERT INTO settings (key, value) VALUES ('bestilling.menu_standard', ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify({
        items: [
            { id: 'r91', name: 'Grisen', tags: ['vegan'], allergens: 'Gluten, Soja', description: 'Langtidsstegt' },
            { id: 'r92', name: 'Salaten' },   // uden ekstra-felter
        ]
    }));
    const em3 = buildEventMenu(db, eventId, 'standard');
    const i91 = em3.items.find(i => i.id === 'r91');
    const i92 = em3.items.find(i => i.id === 'r92');
    eq(i91.allergens, 'Gluten, Soja', 'allergener flettet ind fra bestillingsmenuen');
    eq(JSON.stringify(i91.tags), JSON.stringify(['vegan']), 'tags flettet ind');
    eq(i91.description, 'Langtidsstegt', 'beskrivelse flettet ind');
    eq(i92.allergens, '', 'ret uden data → tom (ingen fejl)');
    eq(JSON.stringify(i92.tags), JSON.stringify([]), 'ret uden data → tomme tags');

    // ── Tre roller: prep (0 kr) · salg (rigtige priser) · gebyr (negativ) ───
    const { lines: rSale } = await resolvePrepLines([{ grocy_recipe_id: 91, antal: 2 }], mockGrocy);
    const priced = rSale.map(l => ({ ...l, unit_price: 91 }));      // eventets menupris
    const DAY3 = '2026-08-01';
    const sPrep = applyPrepPush(db, { event, date: DAY3, resolved: rSale,  role: 'prep'  });
    const sSale = applyPrepPush(db, { event, date: DAY3, resolved: priced, role: 'sales' });
    const sFee  = applyPrepPush(db, { event, date: DAY3, role: 'fee',
        resolved: [{ product_name: 'Betalingsgebyr (estimat 3 %)', quantity: 1, unit: 'stk', unit_price: 5.46 }] });

    ok(sPrep.bonId !== sSale.bonId && sSale.bonId !== sFee.bonId, 'tre SEPARATE bons pr. dag');
    const bonOf = id => db.prepare(`SELECT b.*, sd.code AS status_code, pc.code AS pc_code
        FROM bons b JOIN status_definitions sd ON b.status_id=sd.id
        JOIN price_categories pc ON b.price_category_id=pc.id WHERE b.id=?`).get(id);
    const bPrep = bonOf(sPrep.bonId), bSale = bonOf(sSale.bonId), bFee = bonOf(sFee.bonId);

    eq(bPrep.pc_code, 'produktion', 'prep: priskategori produktion');
    eq(Number(bPrep.total_price), 0, 'prep: 0 kr (vareforbrug, ikke omsætning)');
    eq(bSale.pc_code, 'festival', 'salg: festival-priskategori');
    eq(bSale.event_role, 'sales', 'salg: event_role=sales');
    eq(bSale.status_code, 'BETALT', 'salg: BETALT (pengene er modtaget)');
    eq(Number(bSale.total_price), 182, 'salg: 2 × 91 kr = 182 (afstemmes mod banken)');
    eq(bFee.event_role, 'expense', 'gebyr: event_role=expense');
    eq(Number(bFee.is_internal), 1, 'gebyr: is_internal=1 (netter ikke mod omsætning)');
    ok(Number(bFee.total_price) < 0, 'gebyr: negativ total');
    eq(Number(db.prepare(`SELECT moms_included FROM bon_lines WHERE bon_id=?`).get(sFee.bonId).moms_included), 0,
       'gebyr-linje er ex moms (migration 104)');
    eq(db.prepare(`SELECT COUNT(*) n FROM event_bridge_bons WHERE event_id=? AND delivery_date=?`).get(eventId, DAY3).n, 3,
       'alle tre roller registreret som bro-ejede');

    // Idempotens pr. rolle: samme dag igen → samme bons
    const again = applyPrepPush(db, { event, date: DAY3, resolved: priced, role: 'sales' });
    eq(again.action, 'updated', 'salg: andet push → updated');
    eq(again.bonId, sSale.bonId, 'salg: samme bon (ingen dublet)');

    console.log(`\nFase 3 (event-bro prep): ${pass} PASS · ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
