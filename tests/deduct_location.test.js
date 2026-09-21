// tests/deduct_location.test.js
// ============================================================
// #535 — hvor gik lagertrækket hen?
//
// Alt der skriver til Grocy følger settings.default_grocy_location_id. Peger
// den på Test, trækkes lageret DÉR: produktions-lageret rører sig ikke, bonen
// markeres som trukket, og trækket kan ikke gentages (idempotens-vagten).
// Uden et spor kunne det kun findes ved at kigge i Grocys stock_log.
//
// Skemaet bygges af de RIGTIGE migrations i en temp-DB, og Grocy stubbes —
// testen må hverken røre udviklerens database eller en rigtig Grocy (#516).
//
// Kør:  node --experimental-sqlite --test tests/deduct_location.test.js
// ============================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROD = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deduct-loc-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

// Grocy stubbes FØR helpers indlæses — ellers ville et træk gå på nettet.
const grocy = require(path.join(ROD, 'services', 'grocyAdapter'));
let consumeKald = [];
grocy.consumeRecipes = async (linjer) => {
    consumeKald.push(linjer);
    // Ingen linjer → intet resultat. En attrap der altid svarer med et træk
    // ville skjule 'empty'-tilfældet, som er præcis det vi vil måle.
    return (linjer && linjer.length)
        ? [{ product_id: 1, product_name: 'Mayo', success: true, amount: 1 }]
        : [];
};

const H = require(path.join(ROD, 'db', 'helpers'));
const { getDb } = require(path.join(ROD, 'db', 'database'));

const db = getDb();
const sætAktiv = (id) => db.prepare(`UPDATE settings SET value = ? WHERE key = 'default_grocy_location_id'`).run(String(id));
const locId = (code) => db.prepare('SELECT id FROM locations WHERE code = ?').get(code).id;

/* ── 1. Hvad er drift, og hvad er ikke? ─────────────────────────────── */

test('test og den udfasede cafe er ikke drift — HQ og trailer er', () => {
    assert.strictEqual(H.isNonDriftLocation({ code: 'test' }), true);
    assert.strictEqual(H.isNonDriftLocation({ code: 'cafe' }), true);
    assert.strictEqual(H.isNonDriftLocation({ code: 'hq' }), false);
    // Trailer og festival er LEGITIME skrivemål (#81) — en advarsel dér ville
    // lære folk at klikke advarsler væk.
    assert.strictEqual(H.isNonDriftLocation({ code: 'trailer' }), false);
    assert.strictEqual(H.isNonDriftLocation(null), false, 'ukendt lokation er ikke en anklage');
});

test('store og små bogstaver betyder ikke noget', () => {
    assert.strictEqual(H.isNonDriftLocation({ code: 'TEST' }), true);
});

test('activeGrocyLocation svarer det settings peger på', () => {
    sætAktiv(locId('hq'));
    assert.strictEqual(H.activeGrocyLocation().code, 'hq');
    sætAktiv(locId('test'));
    assert.strictEqual(H.activeGrocyLocation().code, 'test');
});

/* ── 2. Sporet: hvor gik trækket hen? ───────────────────────────────── */

function opretBon({ medLinjer = true } = {}) {
    const statusId = db.prepare(`SELECT id FROM status_definitions WHERE code = 'GODKENDT'`).get().id;
    // bons.location_id er bonens EGEN lokation (hvor ordren hører hjemme) og er
    // noget andet end hvor trækket lander — se migration 186. Her: altid HQ, så
    // testen måler forskellen og ikke bare gentager den.
    const r = db.prepare(
        `INSERT INTO bons (bon_number, order_date, delivery_date, status_id, location_id, pax)
         VALUES (?, ?, ?, ?, ?, 10)`
    ).run(`T${Date.now()}${Math.random().toString(36).slice(2, 6)}`, H.todayISO(), H.todayISO(), statusId, locId('hq'));
    if (medLinjer) {
        db.prepare(
            `INSERT INTO bon_lines (bon_id, product_name, quantity, unit_price, line_total, grocy_recipe_id)
             VALUES (?, 'Sandwich', 2, 50, 100, 42)`
        ).run(r.lastInsertRowid);
    }
    return r.lastInsertRowid;
}
const læs = (id) => db.prepare(
    `SELECT inventory_deducted, inventory_deduct_status, inventory_deducted_location_id FROM bons WHERE id = ?`
).get(id);
const vent = () => new Promise(r => setImmediate(() => setImmediate(r)));

test('et træk skriver ned hvilken Grocy det ramte', async () => {
    db.prepare(`UPDATE settings SET value = '1' WHERE key = 'inventory_auto_deduct'`).run();
    sætAktiv(locId('test'));
    const id = opretBon();
    H.autoConsumeBonInventory(id);
    await vent();
    const b = læs(id);
    assert.strictEqual(b.inventory_deducted, 1);
    assert.strictEqual(b.inventory_deducted_location_id, locId('test'),
        'uden lokationen kan et fejlagtigt træk kun gættes bagefter');
});

test('samme bon i produktion peger på produktionen', async () => {
    sætAktiv(locId('hq'));
    const id = opretBon();
    H.autoConsumeBonInventory(id);
    await vent();
    assert.strictEqual(læs(id).inventory_deducted_location_id, locId('hq'));
});

test('intet at trække → ingen lokation (vi skriver kun ned hvor der FAKTISK blev trukket)', async () => {
    sætAktiv(locId('test'));
    const id = opretBon({ medLinjer: false });
    H.autoConsumeBonInventory(id);
    await vent();
    const b = læs(id);
    assert.strictEqual(b.inventory_deduct_status, 'empty');
    assert.strictEqual(b.inventory_deducted_location_id, null);
});

test('et forsøgt træk der fejler skriver også lokationen', async () => {
    const orig = grocy.consumeRecipes;
    grocy.consumeRecipes = async () => { throw new Error('Grocy nede'); };
    sætAktiv(locId('test'));
    const id = opretBon();
    H.autoConsumeBonInventory(id);
    await vent(); await vent();
    const b = læs(id);
    grocy.consumeRecipes = orig;
    assert.strictEqual(b.inventory_deduct_status, 'failed');
    assert.strictEqual(b.inventory_deducted_location_id, locId('test'),
        'ellers kan en fejlet bon ikke skelnes fra en der ramte den forkerte Grocy');
});

/* ── 3. Vagthunden finder dem bagefter ──────────────────────────────── */

test('vagthunden rapporterer trækket i den forkerte Grocy — og kun det', () => {
    const { findWrongLocation } = require(path.join(ROD, 'scripts', 'check-inventory-deduct.js'));
    const fundet = findWrongLocation(db, 3);
    const koder = [...new Set(fundet.map(r => r.location_code))];
    assert.ok(fundet.length >= 1, 'de test-trukne bons skal findes');
    assert.deepStrictEqual(koder, ['test'], 'kun ikke-drift-lokationer må rapporteres');
    assert.ok(fundet.every(r => r.location_name), 'alarmen skal kunne sige hvor det gik hen');
});

/* ── 3b. Advarslen må kun komme når der FAKTISK blev trukket ────────── */

test('slukket lagertræk → intet træk, ingen lokation, ingen advarsel', async () => {
    db.prepare(`UPDATE settings SET value = '0' WHERE key = 'inventory_auto_deduct'`).run();
    sætAktiv(locId('test'));
    const id = opretBon();
    const svar = H.autoConsumeBonInventory(id);
    await vent();
    assert.strictEqual(svar.started, false, 'der blev ikke sat noget træk i gang');
    assert.strictEqual(læs(id).inventory_deducted_location_id, null);
    db.prepare(`UPDATE settings SET value = '1' WHERE key = 'inventory_auto_deduct'`).run();
});

test('en bon der allerede har trukket starter ikke et nyt træk', async () => {
    sætAktiv(locId('test'));
    const id = opretBon();
    assert.strictEqual(H.autoConsumeBonInventory(id).started, true);
    await vent();
    assert.strictEqual(H.autoConsumeBonInventory(id).started, false, 'idempotens — og dermed ingen ny advarsel');
});

test('et rigtigt træk svarer hvor det landede', async () => {
    sætAktiv(locId('test'));
    const id = opretBon();
    const svar = H.autoConsumeBonInventory(id);
    await vent();
    assert.strictEqual(svar.started, true);
    assert.strictEqual(svar.location.code, 'test');
});

/* ── 4. Advarslen når man står ved skærmen ──────────────────────────── */

test('status-ruten advarer ved LEVERET når den aktive Grocy ikke er drift', () => {
    const src = fs.readFileSync(path.join(ROD, 'routes', 'bons.js'), 'utf8');
    const blok = src.slice(src.indexOf('let grocyWarning'), src.indexOf('grocy_warning: grocyWarning'));
    assert.ok(/isNonDriftLocation\(location\)/.test(blok), 'advarslen skal bruge den delte regel');
    // Ruten må ikke gentage reglerne for hvornår der trækkes — den spørger trækket.
    assert.ok(/started\s*&&/.test(blok), 'advarslen skal afhænge af om der FAKTISK blev trukket');
    assert.ok(/=\s*autoConsumeBonInventory\(id\)/.test(blok), 'svaret fra trækket skal bruges');
    // Ikke en spærring: trækket sker alligevel. Der kan være en grund til at stå i Test.
    assert.ok(!/return\s+res\.status\(4\d\d\)/.test(blok), 'advarslen må ikke spærre skiftet');
});

test('alle tre skærme viser advarslen — den forsvinder ikke af sig selv', () => {
    for (const f of ['kitchen/today.js', 'shared/bon_drawer.js', 'mobile/views/bons.js']) {
        const src = fs.readFileSync(path.join(ROD, f), 'utf8');
        assert.ok(/grocy_warning/.test(src) && /showGrocyWarning/.test(src), `${f} viser ikke advarslen`);
    }
    const utils = fs.readFileSync(path.join(ROD, 'shared', 'utils.js'), 'utf8');
    const fn = utils.slice(utils.indexOf('function showGrocyWarning'), utils.indexOf('function mailIcon'));
    assert.ok(!/setTimeout/.test(fn),
        'beskeden må ikke forsvinde af sig selv — trækket kan ikke gentages, så den er det eneste varsel');
});
