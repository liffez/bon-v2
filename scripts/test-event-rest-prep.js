// scripts/test-event-rest-prep.js
// ============================================================
// REST-PREP (migration 166): forecast-prep-bonnen holder RESTEN op til dagens
// mål, så den og broens forudbestillings-bon ikke tælles dobbelt.
//
//     mål for dagen  =  max(forecast, forudbestilt)     ← pr. kategori, pr. dag
//     rest-bonnen    =  mål − alt andet preppet den dag
//
// Kører in-process mod en isoleret temp-DB (migrations → getDb-singleton), så
// drift aldrig røres. Rammer den ÆGTE reconcileRestBon(db, …) — samme funktion
// broen, forecast-PUT og toggle-endpointet kalder. Ingen Grocy, ingen HTTP.
//
// Kør:  node --experimental-sqlite scripts/test-event-rest-prep.js
// ============================================================

const path = require('path');
const os   = require('os');

const TEST_DB = path.join(os.tmpdir(), `bon-test-rest-prep-${Date.now()}.db`);

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) pass++;
    else { fail++; console.error('  ✗ ' + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (fik ${JSON.stringify(a)}, ventede ${JSON.stringify(b)})`); }

async function main() {
    process.env.DB_PATH = TEST_DB;
    process.env.NODE_ENV = 'test';
    const { runMigrations } = require('../db/migrate');
    runMigrations(TEST_DB);

    const { getDb } = require('../db/database');
    const db = getDb();
    const {
        reconcileRestBon, computeDayTargets, applyKitchenMark, restKitchenText,
    } = require('../routes/events');

    const locId  = db.prepare(`SELECT id FROM locations LIMIT 1`).get().id;
    const prodPc = db.prepare(`SELECT id FROM price_categories WHERE code='produktion'`).get().id;
    const festPc = db.prepare(`SELECT id FROM price_categories WHERE code='festival'`).get().id;
    const stId   = code => db.prepare(`SELECT id FROM status_definitions WHERE code=?`).get(code).id;

    const DAY1 = '2026-09-02';
    const DAY2 = '2026-09-03';
    const SW   = '01 Sandwich';
    const ACC  = 'Tilbehør & Bokse';

    let bonSeq = 0;
    function mkBon({ eventId, date, role = 'prep', pc = prodPc, status = 'GODKENDT',
                     lines = [], autoRest = 0, coversUntil = null, kitchen = null, deducted = 0 }) {
        const num = `T_RP_${++bonSeq}`;
        const id = Number(db.prepare(`
            INSERT INTO bons (bon_number, status_id, location_id, price_category_id, event_id, event_role,
                              event_covers_until, event_prep_auto_rest, order_date, delivery_date,
                              delivery_type, pax, total_units, payment_type, kitchen_info,
                              inventory_deducted, total_price, total_with_delivery)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'event', 0, 0, 'cash', ?, ?, 0, 0)
        `).run(num, stId(status), locId, pc, eventId, role, coversUntil, autoRest,
               DAY1, date, kitchen, deducted).lastInsertRowid);
        const ins = db.prepare(`
            INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit, unit_price, line_total, sort_order)
            VALUES (?, ?, ?, ?, 'stk', 0, 0, ?)
        `);
        lines.forEach((l, i) => ins.run(id, l.name, l.cat, l.qty, i));
        const { recalcBonTotalUnits } = require('../db/helpers');
        recalcBonTotalUnits(db, id);
        return id;
    }
    function markBridge(eventId, date, bonId, role = 'prep') {
        db.prepare(`INSERT INTO event_bridge_bons (event_id, delivery_date, role, bon_id) VALUES (?,?,?,?)`)
          .run(eventId, date, role, bonId);
    }
    function mkEvent(name) {
        return Number(db.prepare(`
            INSERT INTO events (name, location_id, model, start_date, end_date, status)
            VALUES (?, ?, 'light', ?, ?, 'planning')
        `).run(name, locId, DAY1, DAY2).lastInsertRowid);
    }
    function setForecast(eventId, date, cat, qty) {
        db.prepare(`INSERT INTO event_forecast (event_id, forecast_date, category, expected_qty) VALUES (?,?,?,?)`)
          .run(eventId, date, cat, qty);
    }
    const qtys = bonId => db.prepare(
        `SELECT product_name AS n, quantity AS q, category AS c FROM bon_lines WHERE bon_id=? ORDER BY sort_order`
    ).all(bonId);
    const units = bonId => db.prepare(`SELECT total_units FROM bons WHERE id=?`).get(bonId).total_units;
    const kitchenOf = bonId => db.prepare(`SELECT kitchen_info FROM bons WHERE id=?`).get(bonId).kitchen_info;

    // ══ 1) Drifts-scenariet: forecast 400, forudbestilt 332 ══════════════════
    // Præcis tallene fra Ungdommens folkemøde 2. sep 2026 (B4147 + B4166).
    {
        const ev = mkEvent('RP drift');
        setForecast(ev, DAY1, SW, 400);
        const bridge = mkBon({ eventId: ev, date: DAY1, lines: [
            { name: '"Tunen"', cat: SW, qty: 93 },
            { name: 'Italieneren', cat: SW, qty: 136 },
            { name: 'Kartoflen', cat: SW, qty: 103 },
        ]});
        markBridge(ev, DAY1, bridge);
        const rest = mkBon({ eventId: ev, date: DAY1, autoRest: 1, lines: [
            { name: '"Tunen"', cat: SW, qty: 133 },
            { name: 'Italieneren', cat: SW, qty: 133 },
            { name: 'Kartoflen', cat: SW, qty: 133 },
            { name: 'Glutenfri Bolle', cat: ACC, qty: 20 },
        ]});

        const r = reconcileRestBon(db, rest);
        eq(r.action, 'updated', 'drift: rest-bonnen blev genberegnet');
        eq(r.rest_total, 68, 'drift: rest = 400 − 332');
        const q = qtys(rest);
        eq(q.filter(x => x.c === SW).reduce((a, x) => a + x.q, 0), 68, 'drift: sandwich-linjer summer til 68');
        // 133/133/133 er jævnt ⇒ 23/23/22 (largest remainder)
        eq(q[0].q + q[1].q + q[2].q, 68, 'drift: fordelt over de tre retter');
        ok(Math.max(q[0].q, q[1].q, q[2].q) - Math.min(q[0].q, q[1].q, q[2].q) <= 1,
           'drift: jævnt mix bevaret (max 1 i forskel)');
        eq(q.find(x => x.c === ACC).q, 20, 'drift: kategori UDEN forecast er urørt (Glutenfri Bolle)');
        eq(units(rest), 68, 'drift: total_units genberegnet');
        ok(/Rest ud over det forudbestilte/.test(kitchenOf(rest)), 'drift: køkkentekst sat');
        ok(kitchenOf(rest).includes('T_RP_1'), 'drift: køkkenteksten peger på bro-bonnen');

        // Sum af de to bons = dagens mål. Det er hele pointen.
        const dayTotal = db.prepare(`
            SELECT COALESCE(SUM(bl.quantity),0) q FROM bons b JOIN bon_lines bl ON bl.bon_id=b.id
            WHERE b.event_id=? AND b.delivery_date=? AND bl.category=?
        `).get(ev, DAY1, SW).q;
        eq(dayTotal, 400, 'drift: de to bons summer til dagens mål — ingen dobbelttælling');
    }

    // ══ 2) Uden flaget røres bonnen ikke ═════════════════════════════════════
    {
        const ev = mkEvent('RP uden flag');
        setForecast(ev, DAY1, SW, 400);
        const bridge = mkBon({ eventId: ev, date: DAY1, lines: [{ name: 'A', cat: SW, qty: 300 }] });
        markBridge(ev, DAY1, bridge);
        const manual = mkBon({ eventId: ev, date: DAY1, lines: [{ name: 'A', cat: SW, qty: 400 }] });
        const r = reconcileRestBon(db, manual);
        eq(r.action, 'skipped', 'uden flag: skipped');
        eq(qtys(manual)[0].q, 400, 'uden flag: tallet er urørt');
    }

    // ══ 3) max(): ordrerne overhaler forecasten ══════════════════════════════
    {
        const ev = mkEvent('RP overhalet');
        setForecast(ev, DAY1, SW, 400);
        const bridge = mkBon({ eventId: ev, date: DAY1, lines: [{ name: 'A', cat: SW, qty: 450 }] });
        markBridge(ev, DAY1, bridge);
        const rest = mkBon({ eventId: ev, date: DAY1, autoRest: 1, lines: [{ name: 'B', cat: SW, qty: 133 }] });

        const { targets } = computeDayTargets(db, ev, DAY1, DAY1);
        eq(targets.get(SW), 450, 'overhalet: mål = max(400, 450) = 450');
        const r = reconcileRestBon(db, rest);
        eq(r.rest_total, 0, 'overhalet: rest = 0 (ordrerne dækker hele målet)');
        eq(qtys(rest)[0].q, 0, 'overhalet: linjen sat til 0');
        eq(units(rest), 0, 'overhalet: total_units = 0 — tæller ikke i ugeoversigten');
        ok(/hele dagens mål er forudbestilt/.test(kitchenOf(rest)),
           'overhalet: køkkentekst forklarer hvorfor den står med 0');
        ok(kitchenOf(rest).includes('T_RP_'), 'overhalet: teksten peger på den bon de skal lave efter');

        // …og tilbage op igen når en ordre annulleres. Alt er 0, så der findes
        // intet mix at bevare — jævn fordeling er det ærligste gæt.
        db.prepare(`UPDATE bon_lines SET quantity = 200 WHERE bon_id = ?`).run(bridge);
        const back = reconcileRestBon(db, rest);
        eq(back.rest_total, 200, 'annulleret ordre: rest = 400 − 200');
        eq(qtys(rest)[0].q, 200, 'annulleret ordre: bonnen kommer op igen');
    }

    // ══ 4) Jævn fordeling når alt er nulstillet (flere linjer) ═══════════════
    {
        const ev = mkEvent('RP genrejsning');
        setForecast(ev, DAY1, SW, 90);
        const bridge = mkBon({ eventId: ev, date: DAY1, lines: [{ name: 'A', cat: SW, qty: 90 }] });
        markBridge(ev, DAY1, bridge);
        const rest = mkBon({ eventId: ev, date: DAY1, autoRest: 1, lines: [
            { name: 'X', cat: SW, qty: 0 }, { name: 'Y', cat: SW, qty: 0 }, { name: 'Z', cat: SW, qty: 0 },
        ]});
        db.prepare(`UPDATE bon_lines SET quantity = 30 WHERE bon_id = ?`).run(bridge);
        const r = reconcileRestBon(db, rest);
        eq(r.rest_total, 60, 'genrejsning: rest = 90 − 30');
        const q = qtys(rest).map(x => x.q);
        eq(q.reduce((a, b) => a + b, 0), 60, 'genrejsning: summen rammer');
        ok(Math.max(...q) - Math.min(...q) <= 1, 'genrejsning: jævn fordeling når intet mix findes');
    }

    // ══ 5) Frysen — køkkenet må ikke få grundlaget revet væk ═════════════════
    {
        const ev = mkEvent('RP frys');
        setForecast(ev, DAY1, SW, 400);
        const bridge = mkBon({ eventId: ev, date: DAY1, lines: [{ name: 'A', cat: SW, qty: 300 }] });
        markBridge(ev, DAY1, bridge);

        const igang = mkBon({ eventId: ev, date: DAY1, status: 'IGANG', autoRest: 1,
                              lines: [{ name: 'B', cat: SW, qty: 400 }] });
        const r1 = reconcileRestBon(db, igang);
        eq(r1.action, 'frozen', 'frys: IGANG genberegnes ikke');
        eq(r1.reason, 'status', 'frys: årsag = status');
        eq(qtys(igang)[0].q, 400, 'frys: tallet er urørt');

        const ev2 = mkEvent('RP frys lager');
        setForecast(ev2, DAY1, SW, 400);
        const br2 = mkBon({ eventId: ev2, date: DAY1, lines: [{ name: 'A', cat: SW, qty: 300 }] });
        markBridge(ev2, DAY1, br2);
        const trukket = mkBon({ eventId: ev2, date: DAY1, autoRest: 1, deducted: 1,
                                lines: [{ name: 'B', cat: SW, qty: 400 }] });
        const r2 = reconcileRestBon(db, trukket);
        eq(r2.action, 'frozen', 'frys: trukket lager genberegnes ikke');
        eq(r2.reason, 'stock_deducted', 'frys: årsag = lager trukket');
        eq(qtys(trukket)[0].q, 400, 'frys: tallet er urørt efter lagertræk');
    }

    // ══ 6) Køkkentekst: menneskets egen tekst overlever ══════════════════════
    {
        eq(applyKitchenMark('', '⟳ ny'), '⟳ ny', 'køkkentekst: tom → vores linje');
        eq(applyKitchenMark('⟳ gammel\nHusk kølekasse', '⟳ ny'), '⟳ ny\nHusk kølekasse',
           'køkkentekst: kun vores første linje skrives om');
        eq(applyKitchenMark('Husk kølekasse', '⟳ ny'), '⟳ ny\nHusk kølekasse',
           'køkkentekst: menneskets tekst skubbes ned, ikke væk');
        eq(applyKitchenMark('⟳ gammel', '⟳ gammel'), '⟳ gammel', 'køkkentekst: idempotent');
        ok(restKitchenText(0, []).includes('0'), 'køkkentekst: rest 0 uden bro-bon giver stadig en forklaring');
        ok(restKitchenText(12, ['B1', 'B2']).includes('B1 + B2'), 'køkkentekst: flere bro-bons nævnes begge');
        // Sætningen skal kunne LÆSES. Første udgave skrev 'Det er se B4166 I skal
        // lave efter', fordi bon-numrene selv bar et 'se '.
        eq(restKitchenText(0, ['B4166']), '⟳ 0 — hele dagens mål er forudbestilt. Det er B4166 I skal lave efter.',
           'køkkentekst: rest 0 er en læsbar sætning');
        eq(restKitchenText(68, ['B4166']), '⟳ Rest ud over det forudbestilte (se B4166). Tallet opdateres automatisk indtil køkkenet går i gang.',
           'køkkentekst: rest > 0 er en læsbar sætning');
    }

    // ══ 7) max() regnes PR. DAG, ikke på summen ══════════════════════════════
    // Dag 1: forecast 100, forudbestilt 150 → mål 150.  Dag 2: 100 vs 20 → 100.
    // Summeret først ville give max(200, 170) = 200 og altså for lidt.
    {
        const ev = mkEvent('RP flerdags');
        setForecast(ev, DAY1, SW, 100);
        setForecast(ev, DAY2, SW, 100);
        const b1 = mkBon({ eventId: ev, date: DAY1, lines: [{ name: 'A', cat: SW, qty: 150 }] });
        markBridge(ev, DAY1, b1);
        const b2 = mkBon({ eventId: ev, date: DAY2, lines: [{ name: 'A', cat: SW, qty: 20 }] });
        markBridge(ev, DAY2, b2);

        const { targets } = computeDayTargets(db, ev, DAY1, DAY2);
        eq(targets.get(SW), 250, 'flerdags: mål = max(100,150) + max(100,20) = 250');

        // Én rest-bon der dækker begge dage: 250 − (150 + 20) = 80.
        const rest = mkBon({ eventId: ev, date: DAY1, autoRest: 1, coversUntil: DAY2,
                             lines: [{ name: 'B', cat: SW, qty: 999 }] });
        const r = reconcileRestBon(db, rest);
        eq(r.rest_total, 80, 'flerdags: rest = 250 − 170');
        eq(qtys(rest)[0].q, 80, 'flerdags: linjen sat til 80');
    }

    // ══ 8) Kun ÉN rest-bon pr. (event, dag) — ellers kan de svinge ═══════════
    {
        const ev = mkEvent('RP dublet');
        mkBon({ eventId: ev, date: DAY1, autoRest: 1, lines: [{ name: 'A', cat: SW, qty: 10 }] });
        let threw = false;
        try { mkBon({ eventId: ev, date: DAY1, autoRest: 1, lines: [{ name: 'B', cat: SW, qty: 10 }] }); }
        catch (e) { threw = /UNIQUE|constraint/i.test(String(e.message)); }
        ok(threw, 'dublet: to rest-bons samme dag afvises af databasen');
        // …men på en ANDEN dag er det helt i orden.
        let ok2 = true;
        try { mkBon({ eventId: ev, date: DAY2, autoRest: 1, lines: [{ name: 'C', cat: SW, qty: 10 }] }); }
        catch (e) { ok2 = false; }
        ok(ok2, 'dublet: én rest-bon pr. dag er tilladt');
    }

    // ══ 9) Kategori med mål, men ingen linjer at fordele på ══════════════════
    // Vi opfinder ikke produkter — det er et menneskevalg. Men vi siger det.
    {
        const ev = mkEvent('RP manglende mix');
        setForecast(ev, DAY1, '02 Salat', 50);
        setForecast(ev, DAY1, SW, 100);
        const rest = mkBon({ eventId: ev, date: DAY1, autoRest: 1, lines: [{ name: 'A', cat: SW, qty: 20 }] });
        const r = reconcileRestBon(db, rest);
        eq(qtys(rest)[0].q, 100, 'manglende mix: sandwich fyldes op til forecasten');
        ok(r.warnings.some(w => w.includes('02 Salat')), 'manglende mix: salat-manglen rapporteres');
        ok(!qtys(rest).some(l => l.c === '02 Salat'), 'manglende mix: der opfindes ingen salat-linje');
    }

    // ══ 10) Uændret er uændret (idempotens) ═════════════════════════════════
    {
        const ev = mkEvent('RP idempotens');
        setForecast(ev, DAY1, SW, 100);
        const br = mkBon({ eventId: ev, date: DAY1, lines: [{ name: 'A', cat: SW, qty: 40 }] });
        markBridge(ev, DAY1, br);
        const rest = mkBon({ eventId: ev, date: DAY1, autoRest: 1, lines: [{ name: 'B', cat: SW, qty: 133 }] });
        eq(reconcileRestBon(db, rest).action, 'updated', 'idempotens: første kørsel ændrer');
        eq(reconcileRestBon(db, rest).action, 'unchanged', 'idempotens: anden kørsel ændrer intet');
        eq(qtys(rest)[0].q, 60, 'idempotens: tallet står stille på 100 − 40');
    }

    // ══ 11) BROENS TRIGGER — den der betyder noget i drift ═══════════════════
    // Forudbestillinger kan komme ind helt frem til bestillingsfristen, så det
    // er broen der holder resten ajour. Den ÆGTE route køres her (express-app
    // med routeren monteret), med Grocy stubbet i require-cachen — ellers ville
    // wiringen kun være efterprøvet ved at kigge på den.
    await testBridgeTrigger(db, mkEvent, setForecast, qtys, units);

    console.log(`\n${pass} PASS · ${fail} FAIL`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });

// ── Broens trigger: den ægte /webhook/event-prep-route ─────────────────────
// Grocy stubbes i require-cachen FØR routes/event-bridge loades, så
// resolvePrepLines kan mappe uden netværk. Alt andet er produktionskoden.
async function testBridgeTrigger(db, mkEvent, setForecast, qtys, units) {
    const http = require('http');
    const grocyPath = require.resolve('../services/grocyAdapter');
    const real = require.cache[grocyPath];
    require.cache[grocyPath] = {
        id: grocyPath, filename: grocyPath, loaded: true, exports: {
            getRecipes: async () => [
                { id: 91, name: '"Tunen"', category: '01 Sandwich', unit: 'stk', prices: { produktion: 0, festival: 91 }, cost_price: 20 },
                { id: 92, name: 'Italieneren', category: '01 Sandwich', unit: 'stk', prices: { produktion: 0, festival: 91 }, cost_price: 20 },
            ],
            getRecipesRaw: async () => [],
        },
    };
    // Broen kan være loadet af en tidligere require — smid den ud, så stubben rammer.
    delete require.cache[require.resolve('../routes/event-bridge')];
    const bridgeRouter = require('../routes/event-bridge');

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/webhook', bridgeRouter);
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    const port = server.address().port;

    const DAY = '2026-09-02';
    const ev = mkEvent('RP bro-trigger');
    setForecast(ev, DAY, '01 Sandwich', 400);
    // Office' rest-bon findes ALLEREDE — som i drift, hvor den blev lavet før
    // forudbestillingerne begyndte at komme ind.
    const rest = Number(db.prepare(`
        INSERT INTO bons (bon_number, status_id, location_id, price_category_id, event_id, event_role,
                          event_prep_auto_rest, order_date, delivery_date, delivery_type, pax, total_units,
                          payment_type, total_price, total_with_delivery)
        VALUES ('T_RP_BRIDGE', (SELECT id FROM status_definitions WHERE code='GODKENDT'),
                (SELECT id FROM locations LIMIT 1), (SELECT id FROM price_categories WHERE code='produktion'),
                ?, 'prep', 1, ?, ?, 'event', 0, 0, 'cash', 0, 0)
    `).run(ev, DAY, DAY).lastInsertRowid);
    db.prepare(`INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit, unit_price, line_total, sort_order)
                VALUES (?, '"Tunen"', '01 Sandwich', 200, 'stk', 0, 0, 0)`).run(rest);
    db.prepare(`INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit, unit_price, line_total, sort_order)
                VALUES (?, 'Italieneren', '01 Sandwich', 200, 'stk', 0, 0, 1)`).run(rest);
    require('../db/helpers').recalcBonTotalUnits(db, rest);
    eq(units(rest), 400, 'bro-trigger: rest-bonnen starter på hele forecasten');

    async function push(lines) {
        const res = await fetch(`http://localhost:${port}/webhook/event-prep`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event_id: ev, date: DAY, lines }),
        });
        return { status: res.status, data: await res.json() };
    }

    const r1 = await push([{ grocy_recipe_id: 91, antal: 120 }, { grocy_recipe_id: 92, antal: 80 }]);
    ok(r1.status === 200 || r1.status === 201, `bro-trigger: forudbestilling modtaget (${r1.status})`);
    ok(Array.isArray(r1.data.rest_prep), 'bro-trigger: svaret rapporterer genberegningen');
    eq(units(rest), 200, 'bro-trigger: rest faldt til 400 − 200 da ordrerne landede');

    // Flere ordrer ⇒ resten falder yderligere, uden at nogen rører noget.
    const r2 = await push([{ grocy_recipe_id: 91, antal: 200 }, { grocy_recipe_id: 92, antal: 132 }]);
    ok(r2.status === 200, 'bro-trigger: næste ordre modtaget');
    eq(units(rest), 68, 'bro-trigger: rest = 400 − 332 (drifts-tallet)');
    const q = qtys(rest);
    ok(Math.abs(q[0].q - q[1].q) <= 1, 'bro-trigger: mixet bevaret proportionalt (200/200 → 34/34)');

    // Summen af broens bon og resten ER dagens mål.
    const dayTotal = db.prepare(`
        SELECT COALESCE(SUM(bl.quantity),0) q FROM bons b JOIN bon_lines bl ON bl.bon_id=b.id
        LEFT JOIN price_categories pc ON pc.id = b.price_category_id
        WHERE b.event_id=? AND b.delivery_date=? AND pc.code='produktion'
    `).get(ev, DAY).q;
    eq(dayTotal, 400, 'bro-trigger: de to bons summer til målet — ingen dobbelttælling');

    // ── En fejlet genberegning må ALDRIG koste kundens ordre ──────────────
    // Forudbestillingen ER landet når vi når hertil; en fejl i genberegningen
    // er en efterfølgende justering, ikke en grund til at svare 500 og få
    // event-order-3 til at prøve igen. Samme princip som goodsReceiptWebhook.
    // Vi patcher den EKSPORTEREDE funktion og genindlæser broen, så dens
    // destrukturering rammer den fejlende udgave.
    const eventsMod = require('../routes/events');
    const realReconcile = eventsMod.reconcileRestBonsForEvent;
    eventsMod.reconcileRestBonsForEvent = () => { throw new Error('boom'); };
    delete require.cache[require.resolve('../routes/event-bridge')];
    const brokenRouter = require('../routes/event-bridge');
    const app2 = express();
    app2.use(express.json());
    app2.use('/webhook', brokenRouter);
    const server2 = http.createServer(app2);
    await new Promise(r => server2.listen(0, r));
    const port2 = server2.address().port;

    const ev2 = mkEvent('RP bro-fejl');
    setForecast(ev2, DAY, '01 Sandwich', 400);
    const res3 = await fetch(`http://localhost:${port2}/webhook/event-prep`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: ev2, date: DAY, lines: [{ grocy_recipe_id: 91, antal: 7 }] }),
    });
    const body3 = await res3.json();
    ok(res3.status === 200 || res3.status === 201, `bro-robusthed: ordren tages imod selvom genberegningen kaster (${res3.status})`);
    ok(body3.rest_prep && body3.rest_prep.error, 'bro-robusthed: fejlen rapporteres i svaret frem for at forsvinde');
    const landed = db.prepare(
        `SELECT COALESCE(SUM(bl.quantity),0) q FROM bons b JOIN bon_lines bl ON bl.bon_id=b.id WHERE b.event_id=?`
    ).get(ev2).q;
    eq(landed, 7 * 2, 'bro-robusthed: forudbestillingen er bogført (prep + salg) trods fejlen');

    eventsMod.reconcileRestBonsForEvent = realReconcile;
    await new Promise(r => server2.close(r));
    await new Promise(r => server.close(r));
    if (real) require.cache[grocyPath] = real; else delete require.cache[grocyPath];
}
