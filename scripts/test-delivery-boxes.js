// scripts/test-delivery-boxes.js
// ==========================================
// Hvor mange kolli buddet skal bære (services/deliveryBoxes.js).
//
// REGRESSIONEN er drifts-scenariet: en leverings-bon med transportkasse-linjer
// og TOM `bons.boxes`-kolonne. Før rettelsen meldte {total_boxes} "[mangler]"
// på den — og By-expressens kasse-tillæg fyrede aldrig, så popoutet viste
// 154 kr hvor logistik-rækkens /calculate viste 254.
//
// Kører mod de RIGTIGE migrations i en temp-DB, så en flyttet kolonne eller en
// ændret seed fælder testen frem for at bestå mod en håndskrevet skemakopi.
//
// Kør med:
//   node --experimental-sqlite scripts/test-delivery-boxes.js
// ==========================================

const path = require('path');
const os = require('os');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), `bon-test-boxes-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const { getDb } = require('../db/database');
const {
    getBoxRecipeIds, invalidateBoxRecipeCache,
    countBoxesFromLines, boxesForBon, boxCountSql
} = require('../services/deliveryBoxes');
const { buildContext, buildBookingPayload, estimateCost } = require('../services/booking_template');
const { getBon } = require('../db/helpers');
const { logBookingEvent } = require('../services/delivery_log');

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  ✓', msg); pass++; }
    else      { console.error('  ✗', msg); fail++; }
}
function assertEqual(actual, expected, msg) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', msg); pass++; }
    else    { console.error('  ✗', msg, '\n      forventet:', expected, '\n      faktisk:  ', actual); fail++; }
}

const db = getDb();
const KASSE = 47;        // Transportkasse
const KASSE_LAAG = 96;   // Transportkasse m låg

// ─── Fixture ──────────────────────────────────────────────
console.log('\n=== Fixture ===');
const statusId = db.prepare(`SELECT id FROM status_definitions WHERE code='NY'`).get()?.id
              || db.prepare(`SELECT id FROM status_definitions ORDER BY id LIMIT 1`).get()?.id;
const locId = db.prepare(`SELECT id FROM locations LIMIT 1`).get()?.id;
const addrId = Number(db.prepare(`
    INSERT INTO addresses (street_name, street_nr, postal_code, city)
    VALUES ('Nørre Allé','7','2200','København N')`).run().lastInsertRowid);

function mkBon(nr, boxes, lines) {
    const id = Number(db.prepare(`
        INSERT INTO bons (bon_number, status_id, location_id, order_date, delivery_date,
                          delivery_time, pickup_time, delivery_type, delivery_address_id,
                          pax, boxes, total_units)
        VALUES (?, ?, ?, '2026-09-01','2026-09-21','11:30','10:45','delivery', ?, 14, ?, 32)
    `).run(nr, statusId, locId, addrId, boxes).lastInsertRowid);
    for (const [rid, name, qty] of lines) {
        db.prepare(`INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, category, quantity, unit, unit_price)
                    VALUES (?,?,?,?,?,'stk',10)`).run(id, rid, name, '06 Emballage', qty);
    }
    return id;
}

// Drifts-scenariet: tom boxes-kolonne, kasserne står som linjer.
const bonDrift = mkBon('T-DRIFT', null, [
    [KASSE_LAAG, 'Transportkasse m låg (emballage)', 1],
    [null,       'Receptions Skinner  (emballage)',  5],
    [KASSE,      'Transportkasse (emballage)',       3]
]);
// Ingen kasser overhovedet.
const bonUdenKasser = mkBon('T-TOM', null, [[null, 'RR Boks  (emballage)', 40]]);
// Kolonnen ER sat — et menneskes tal vinder.
const bonMedKolonne = mkBon('T-KOL', 9, [[KASSE, 'Transportkasse (emballage)', 2]]);
console.log(`  bons: drift=${bonDrift} tom=${bonUdenKasser} kolonne=${bonMedKolonne}`);

// ─── 1. Settingen ─────────────────────────────────────────
console.log('\n=== settings.delivery_box_recipes (migration 180) ===');
assertEqual(getBoxRecipeIds(), [47, 96], 'seedet med Transportkasse (47) + m låg (96)');

db.prepare(`UPDATE settings SET value=? WHERE key='delivery_box_recipes'`)
  .run('[47,"96",0,-3,null,"vrøvl",96]');
invalidateBoxRecipeCache();
assertEqual(getBoxRecipeIds(), [47, 96, 96], 'vrøvl, 0 og negative id filtreres fra');

db.prepare(`UPDATE settings SET value=? WHERE key='delivery_box_recipes'`).run('ikke json');
invalidateBoxRecipeCache();
assertEqual(getBoxRecipeIds(), [], 'ugyldig JSON → tom liste, ikke et crash');

db.prepare(`UPDATE settings SET value=? WHERE key='delivery_box_recipes'`).run('[47,96]');
invalidateBoxRecipeCache();
assertEqual(getBoxRecipeIds(), [47, 96], 'gendannet');

// Cachen skal faktisk cache — ellers er invalidate-hooket meningsløst.
db.prepare(`UPDATE settings SET value='[]' WHERE key='delivery_box_recipes'`).run();
assertEqual(getBoxRecipeIds(), [47, 96], 'cachet værdi bruges indtil den ryddes');
invalidateBoxRecipeCache();
assertEqual(getBoxRecipeIds(), [], 'invalidateBoxRecipeCache() henter på ny');
db.prepare(`UPDATE settings SET value='[47,96]' WHERE key='delivery_box_recipes'`).run();
invalidateBoxRecipeCache();

// ─── 2. countBoxesFromLines (ren) ─────────────────────────
console.log('\n=== countBoxesFromLines ===');
const linjer = [
    { grocy_recipe_id: KASSE_LAAG, quantity: 1 },
    { grocy_recipe_id: null,       quantity: 5 },   // skinner
    { grocy_recipe_id: KASSE,      quantity: 3 },
    { grocy_recipe_id: 999,        quantity: 40 }   // RR Boks
];
assertEqual(countBoxesFromLines(linjer, [47, 96]), 4, 'summerer KUN de udpegede opskrifter (1+3)');
assertEqual(countBoxesFromLines(linjer, [96]), 1, 'listen afgør — kun m låg tæller');
assertEqual(countBoxesFromLines(linjer, []), 0, 'tom liste → intet tæller');
assertEqual(countBoxesFromLines([], [47, 96]), 0, 'ingen linjer → 0');
assertEqual(countBoxesFromLines(null, [47, 96]), 0, 'null → 0, ikke et crash');
assertEqual(countBoxesFromLines([{ grocy_recipe_id: KASSE, quantity: 2.4 }], [47]), 2, 'kolli er hele kasser');
assertEqual(countBoxesFromLines([{ grocy_recipe_id: KASSE, quantity: -3 }], [47]), 0, 'negativt antal tæller ikke');
assertEqual(countBoxesFromLines([{ grocy_recipe_id: '47', quantity: 2 }], [47]), 2, 'id som streng matcher');

// ─── 3. boxesForBon ───────────────────────────────────────
console.log('\n=== boxesForBon ===');
assertEqual(boxesForBon(getBon(bonDrift)), 4, 'DRIFTS-SCENARIET: tom kolonne → talt fra linjerne (1+3)');
assertEqual(boxesForBon(getBon(bonUdenKasser)), null, 'ingen kasse-linjer → null (ikke 0)');
assertEqual(boxesForBon(getBon(bonMedKolonne)), 9, 'bons.boxes har forrang over optællingen');
assertEqual(boxesForBon(null), null, 'null bon → null');

// ─── 4. buildContext → {total_boxes} ──────────────────────
console.log('\n=== buildContext: {total_boxes} ===');
const ctxDrift = buildContext(getBon(bonDrift));
assertEqual(ctxDrift.vars.total_boxes, '4', 'feltet bærer det talte antal');
assert(!ctxDrift.missing.includes('total_boxes'), 'feltet meldes IKKE som manglende');
assertEqual(ctxDrift.boxes, 4, 'kasse-antallet gives retur så prisen kan bruge samme tal');

const ctxTom = buildContext(getBon(bonUdenKasser));
assertEqual(ctxTom.vars.total_boxes, '', 'ingen kasser → tom, så feltet melder [mangler]');
assert(ctxTom.missing.includes('total_boxes'), 'vi påstår ikke "0 kolli" over for buddet');

assertEqual(buildContext(getBon(bonDrift), { boxRecipeIds: [96] }).vars.total_boxes, '1',
            'injiceret liste vinder (testbarhed uden at røre settingen)');

// ─── 5. Prisen: kasse-tillægget skal fyre ─────────────────
console.log('\n=== buildBookingPayload: pris med kasse-tillæg ===');
const byex = db.prepare(`SELECT id, code FROM delivery_vehicles WHERE code='byekspressen'`).get();
db.prepare(`UPDATE delivery_vehicles SET cost_formula_json=? WHERE id=?`)
  .run('{"tiers":[{"max_km":8,"price":154},{"price":400}],"included_boxes":2,"extra_box_cost":50}', byex.id);

const payload = buildBookingPayload(bonDrift, byex.id);
assertEqual(payload.bon.boxes, 4, 'payloadets sammendrag bærer det talte antal');
assertEqual(payload.estimated_cost_dkk, 254,
            'REGRESSION: 154 bytakst + 2 ekstra kasser × 50 = 254 (var 154 med tom kolonne)');

const payloadTom = buildBookingPayload(bonUdenKasser, byex.id);
assertEqual(payloadTom.estimated_cost_dkk, 154, 'uden kasser: bytakst uden tillæg');
assertEqual(payloadTom.bon.boxes, null, 'og sammendraget siger "ingen", ikke 0');

// Selve formlen er urørt — tillægget afhænger af tallet vi giver den.
assertEqual(estimateCost({ cost_formula_json: '{"tiers":[{"price":154}],"included_boxes":2,"extra_box_cost":50}' },
                         { boxes: null }), 154, 'estimateCost er stadig ren: null boxes → intet tillæg');

// ─── 6. boxCountSql ───────────────────────────────────────
console.log('\n=== boxCountSql (queries uden bon_lines) ===');
const b = boxCountSql('b');
const row = db.prepare(`SELECT ${b.sql} AS boxes FROM bons b WHERE b.id = ?`).get(...b.args, bonDrift);
assertEqual(row.boxes, 4, 'subqueryen giver samme tal som countBoxesFromLines');
const rowKol = db.prepare(`SELECT ${b.sql} AS boxes FROM bons b WHERE b.id = ?`).get(...b.args, bonMedKolonne);
assertEqual(rowKol.boxes, 9, 'bons.boxes har forrang også i SQL');
const rowTom = db.prepare(`SELECT ${b.sql} AS boxes FROM bons b WHERE b.id = ?`).get(...b.args, bonUdenKasser);
assertEqual(rowTom.boxes, 0, 'ingen kasse-linjer → 0 i SQL (kalderen oversætter til "ingen")');
const tomListe = boxCountSql('b', []);
assertEqual(tomListe.sql, '0', 'tom liste → konstant 0');
assertEqual(tomListe.args, [], 'og ingen parametre at binde');

// ─── 7. Endpoints der henter bons UDEN deres linjer ───────
// /overview og /routes selecter bonnen direkte, så kasserne tælles i SQL.
// Subqueryens parametre står i SELECT-listen og skal bindes FØR resten —
// får rækkefølgen galt, svarer SQLite "column index out of range" i drift.
// Derfor rammes de ÆGTE routes (monteret in-process, sessionen stubbet;
// den globale auth-gate bor i server.js).
const express = require('express');
const deliveryRouter = require('../routes/delivery');

function mountApi() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { userId: 1, userRole: 'admin' }; next(); });
    app.use('/api/delivery', deliveryRouter);
    return new Promise(resolve => {
        const srv = app.listen(0, () => resolve({ srv, port: srv.address().port }));
    });
}

// ─── 7b. Settings-feltet ──────────────────────────────────
// Uden det kan listen kun ændres med SQL, og så er reglen usynlig for dem der
// skal bruge den. Funktionerne skæres ud af settings/index.html og køres i en
// vm-sandkasse — det er de SAMME funktioner browseren bruger, ikke en kopi.
const vm = require('vm');
const stSrc = fs.readFileSync(path.join(__dirname, '..', 'settings', 'index.html'), 'utf8');
// indexOf(til) SKAL starte fra fra-positionen: slut-ankeret findes også
// tidligere i filen, og så blev udsnittet tomt/omvendt.
const cut = (fra, til) => {
    const a = stSrc.indexOf(fra);
    if (a < 0) throw new Error('fandt ikke start-anker: ' + fra);
    const b = stSrc.indexOf(til, a + fra.length);
    if (b < 0) throw new Error('fandt ikke slut-anker: ' + til);
    return stSrc.slice(a, b);
};
const dbxSrc = cut('var _dbxSelected = [];', 'async function loadDeliveryVehicles() {')
             + cut('function _ucParse(raw) {', '\n}\n') + '\n}\n';

// Attrap-DOM: elementerne husker hvad der blev skrevet i dem.
const el = {};
const mkEl = () => ({ innerHTML: '', textContent: '', value: '', disabled: false });
for (const id of ['dbx-list', 'dbx-add-select', 'dbx-status']) el[id] = mkEl();
const gemteKald = [];
const ctx = vm.createContext({
    document: { getElementById: id => el[id] || null },
    allSettings: { delivery_box_recipes: '[47,96]' },
    getGrocyRecipesCached: async () => ([
        { id: 47, name: 'Transportkasse', category: '06 Emballage' },
        { id: 96, name: 'Transportkasse m låg', category: '06 Emballage' },
        { id: 12, name: 'RR Boks', category: '06 Emballage' }
    ]),
    saveSetting: async (k, v) => { gemteKald.push([k, v]); },
    esc: x => String(x == null ? '' : x),
    setTimeout: () => {},
    console
});
vm.runInContext(dbxSrc + ';globalThis._api = { dbxInit, dbxAddSelected, dbxRemove, sel: () => _dbxSelected };', ctx);
const dbx = ctx._api;

// logBookingEvent er ASYNC (pickup_time kan kræve et ORS-kald). Uden await
// måler vi tilstanden før den har skrevet noget, og assertionen ville bestå
// mod hvad som helst.
(async () => {
    // ── endpoints ──
    console.log('\n=== /overview + /routes: kasse-antal i SQL ===');
    const { srv, port } = await mountApi();
    const api = p => fetch(`http://localhost:${port}/api/delivery${p}`).then(r => r.json());

    const ov = await api('/overview?date=2026-09-21');
    const ovBon = (ov.bons || []).find(x => x.id === bonDrift);
    assert(ovBon, '/overview svarer (args-rækkefølgen holder)');
    assertEqual(ovBon && ovBon.boxes, 4, '/overview: kasserne talt fra linjerne (stod "std" før)');
    const ovTom = (ov.bons || []).find(x => x.id === bonUdenKasser);
    assertEqual(ovTom && ovTom.boxes, 0, '/overview: bon uden kasse-linjer → 0');

    // /calculate driver logistik-rækkens pris. Den SKAL bruge samme kilde som
    // popoutet, ellers viser de to skærme hver sit kasse-antal for samme bon.
    const calcPost = (body) => fetch(`http://localhost:${port}/api/delivery/calculate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }).then(r => r.json());

    const cDrift = await calcPost({ bon_id: bonDrift });
    assertEqual(cDrift.boxes, 4, '/calculate: samme talte antal som popoutet (var ceil(32/16)=2)');
    assertEqual(cDrift.boxes_source, 'counted', 'og den siger at tallet er TALT');

    // Uden kasse-linjer skal der stadig kunne prissættes — dér er et skøn bedre
    // end ingen pris, men det skal kunne skelnes fra en optælling.
    const cTom = await calcPost({ bon_id: bonUdenKasser });
    assertEqual(cTom.boxes, 2, '/calculate uden kasse-linjer: skøn ceil(32/16)=2');
    assertEqual(cTom.boxes_source, 'estimated', 'og den siger at tallet er et SKØN');

    const route = await fetch(`http://localhost:${port}/api/delivery/routes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route_date: '2026-09-21', vehicle_id: byex.id })
    }).then(r => r.json());
    await fetch(`http://localhost:${port}/api/delivery/routes/${route.id}/stops`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bon_id: bonDrift })
    }).then(r => r.json());

    const routes = await api('/routes?date=2026-09-21');
    const routeList = Array.isArray(routes) ? routes : (routes.routes || []);
    const stop = ((routeList.find(r => r.id === route.id)?.stops || []))[0];
    assert(stop, '/routes svarer med stop (args-rækkefølgen holder)');
    assertEqual(stop && stop.boxes, 4, '/routes: stoppet bærer det talte kasse-antal — kapacitets-tjekket kan fyre');
    srv.close();

    console.log('\n=== settings: Hvad tæller som en kasse ===');
    await dbx.dbxInit();
    assertEqual(dbx.sel(), [47, 96], 'læser de gemte id fra settings');
    assert(el['dbx-list'].innerHTML.includes('Transportkasse m låg'),
           'chips viser opskriftens NAVN, ikke bare id');
    assert(el['dbx-add-select'].innerHTML.includes('RR Boks'), 'dropdown har de ikke-valgte');
    // Tæl options i stedet for at lede efter en streng: optionen hedder
    // "Transportkasse (06 Emballage)", så en match på ">Transportkasse<"
    // var altid falsk og kunne ikke se om filteret virkede.
    const optAntal = h => (String(h).match(/<option /g) || []).length;
    assertEqual(optAntal(el['dbx-add-select'].innerHTML), 2,
                'kun de ikke-valgte + pladsholderen (3 opskrifter, 2 valgt)');

    el['dbx-add-select'].value = '12';
    await dbx.dbxAddSelected();
    assertEqual(dbx.sel(), [47, 96, 12], 'tilføjer den valgte');
    assertEqual(gemteKald[gemteKald.length - 1], ['delivery_box_recipes', '[47,96,12]'],
                'og gemmer under den rigtige nøgle');

    await dbx.dbxRemove(47);
    assertEqual(dbx.sel(), [96, 12], 'fjerner den klikkede');
    assertEqual(gemteKald[gemteKald.length - 1][1], '[96,12]', 'og gemmer med det samme');

    // Tom liste betyder at INTET tælles — det skal siges, ikke bare vises tomt.
    await dbx.dbxRemove(96); await dbx.dbxRemove(12);
    assert(el['dbx-list'].textContent.includes('⚠') || el['dbx-list'].innerHTML.includes('⚠'),
           'tom liste advarer om at antal kasser så står tomt overalt');

    // Grocy nede: id'erne skal stadig kunne ses og fjernes — en regel man ikke
    // kan se er en regel man ikke kan rette.
    ctx.allSettings.delivery_box_recipes = '[47,96]';
    ctx.getGrocyRecipesCached = async () => { throw new Error('Grocy nede'); };
    await dbx.dbxInit();
    assertEqual(dbx.sel(), [47, 96], 'Grocy nede → id bevares');
    assert(el['dbx-list'].innerHTML.includes('#47'), 'og vises med deres id');
    assertEqual(el['dbx-add-select'].disabled, true, 'dropdown slås fra frem for at stå tom og forvirre');

    console.log('\n=== delivery_log: estimatet der skrives til databasen ===');
    // Egen bon: rute-stoppet ovenfor har allerede sat vognen på bonDrift, og
    // logBookingEvent skriver kun estimatet når vognen ændrer sig.
    const bonBook = mkBon('T-BOOK', null, [
        [KASSE, 'Transportkasse (emballage)', 3],
        [KASSE_LAAG, 'Transportkasse m låg (emballage)', 1]
    ]);
    await logBookingEvent({ bonId: bonBook, vehicleId: byex.id, status: 'booked', userId: null });
    const gemt = db.prepare(`SELECT delivery_cost_estimated, boxes FROM bons WHERE id=?`).get(bonBook);
    assertEqual(gemt.delivery_cost_estimated, 254,
                'REGRESSION: det gemte estimat bærer kasse-tillægget (var 154)');
    assertEqual(gemt.boxes, null, 'og kolonnen bons.boxes er stadig urørt — vi tæller, vi skriver ikke');

    // ─── Resultat ─────────────────────────────────────────
    console.log(`\n=== Resultat ===\n✓ ${pass} passed,  ✗ ${fail} failed`);
    try { fs.unlinkSync(TEST_DB); } catch {}
    process.exit(fail > 0 ? 1 : 0);
})();
