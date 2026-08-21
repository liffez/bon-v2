// tests/pos_sync.test.js
// ============================================================
// POS-salgsbonnen fra ende til anden: køb → dag → bon.
//
// Skemaet bygges af de RIGTIGE migrations i en :memory:-database, så en
// kolonne der flytter sig får testen til at fejle i stedet for at bestå mod
// en håndskrevet kopi. Zettle er stubbet med fixtures — intet netværk.
//
// Kernepåstandene:
//   • intet event med POS slået til ⇒ ingen bon opstår af sig selv
//   • broen rører ALDRIG en bon den ikke selv har lavet
//   • en bon der er ført videre fryser — og siger det højt
//   • en dag kan ikke komme til at stå to gange
//
// Kør: node --experimental-sqlite --test tests/pos_sync.test.js
// ============================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dbModule = require('../db/database');
let _testDb = null;
dbModule.getDb = () => _testDb;

const sseModule = require('../shared/sse');
const _events = [];
sseModule.broadcast = (name, payload) => _events.push({ name, payload });

const { normalizePurchase } = require('../services/zettleAdapter');
const posSync = require('../services/posSync');

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
const FIX = p => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/zettle', p), 'utf8')).purchases;
const RAW_REAL = FIX('purchases_festival.json');
const RAW_SYN = FIX('purchases_synthetic.json');

const RECIPES = [
    { id: 57, name: 'Kartoflen slider', category: '04 Slider', cost_price: 11.2, co2e: 0.2, unit: 'stk' },
    { id: 52, name: 'Fisken Slider',    category: '04 Slider', cost_price: 12.0, co2e: 0.3, unit: 'stk' },
    { id: 11, name: 'Fisken',           category: '01 Sandwich', cost_price: 24.0, co2e: 0.5, unit: 'stk' },
    { id: 12, name: 'Falaflen',         category: '01 Sandwich', cost_price: 18.0, co2e: 0.3, unit: 'stk' },
];

/* ── Opsætning ────────────────────────────────────────────── */

function freshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
    db.prepare("UPDATE settings SET value = '1' WHERE key = 'zettle_enabled'").run();
    return db;
}

function makeEvent(db, { id = 1, name = 'Testfestival', posEnabled = 1, storeRef = null,
                        start = '2026-08-14', end = '2026-08-15' } = {}) {
    const loc = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get().id;
    db.prepare(`INSERT INTO events (id, name, location_id, start_date, end_date, status, pos_enabled, pos_store_ref)
                VALUES (?,?,?,?,?, 'active', ?, ?)`).run(id, name, loc, start, end, posEnabled, storeRef);
    return id;
}

/** Stub-adapter: leverer fixture-køb som var de hentet fra Zettle. */
function stubAdapter(raws) {
    return {
        isConfigured: () => true,
        getPurchases: async () => raws.map(normalizePurchase),
    };
}

const sync = (db, raws, opts = {}) => posSync.syncPos(db, {
    adapter: stubAdapter(raws),
    from: '2026-08-13', to: '2026-08-16',
    deps: { getRecipes: async () => RECIPES, todayISO: () => '2026-08-16', offsetISO: () => '2026-08-13' },
    ...opts,
});

const day = (db, d) => db.prepare("SELECT * FROM pos_sales_days WHERE source='zettle' AND business_date=?").get(d);
const bonOf = (db, d) => {
    const r = day(db, d);
    return r?.bon_id ? db.prepare('SELECT * FROM bons WHERE id = ?').get(r.bon_id) : null;
};
const linesOf = (db, bonId) => db.prepare('SELECT * FROM bon_lines WHERE bon_id = ? ORDER BY sort_order').all(bonId);
const setStatus = (db, bonId, code) =>
    db.prepare('UPDATE bons SET status_id = (SELECT id FROM status_definitions WHERE code = ?) WHERE id = ?').run(code, bonId);

test.beforeEach(() => { _testDb = freshDb(); _events.length = 0; });

/* ══════════════════════════════════════════════════════════
   MASTER-KONTAKT
   ══════════════════════════════════════════════════════════ */

test('slukket integration henter intet og bygger intet', async () => {
    const db = _testDb;
    db.prepare("UPDATE settings SET value = '0' WHERE key = 'zettle_enabled'").run();
    const r = await sync(db, RAW_REAL);
    assert.equal(r.skipped, true);
    assert.equal(r.reason, 'disabled');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM pos_purchases').get().c, 0);
});

/* ══════════════════════════════════════════════════════════
   RÅ KØB
   ══════════════════════════════════════════════════════════ */

test('købene gemmes, og en gentaget synk laver ikke dubletter', async () => {
    const db = _testDb;
    const a = await sync(db, RAW_REAL);
    assert.equal(a.inserted, RAW_REAL.length);
    const n = db.prepare('SELECT COUNT(*) c FROM pos_purchases').get().c;

    const b = await sync(db, RAW_REAL);
    assert.equal(b.inserted, 0);
    assert.equal(b.updated, RAW_REAL.length);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM pos_purchases').get().c, n,
        'samme køb må ikke kunne ligge to gange — purchase_uuid er nøglen');
});

test('forretningsdagen afgør hvilken dag købet tælles på', async () => {
    const db = _testDb;
    // Det syntetiske køb kl. 00:30 UTC den 16. = 02:30 lokalt ⇒ hører til den 15.
    await sync(db, [RAW_SYN[3]]);
    const row = db.prepare('SELECT business_date FROM pos_purchases').get();
    assert.equal(row.business_date, '2026-08-15');
});

/* ══════════════════════════════════════════════════════════
   INGEN BON UDEN TILVALG
   ══════════════════════════════════════════════════════════ */

test('uden et event med POS slået til opstår der INGEN bon', async () => {
    const db = _testDb;
    makeEvent(db, { posEnabled: 0 });                 // eventet findes, men fluebenet er ikke sat
    await sync(db, RAW_REAL);
    const d = day(db, '2026-08-14');
    assert.ok(d, 'dagen skal stadig registreres — den må ikke forsvinde');
    assert.equal(d.event_id, null);
    assert.equal(d.assign_status, 'unassigned');
    assert.equal(d.bon_id, null);
    assert.ok(d.gross_incl > 0, 'og beløbet skal kunne ses, så det glemte flueben opdages');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM bons').get().c, 0);
});

test('to events samme dag uden salgssted → ambiguous, aldrig et gæt', async () => {
    const db = _testDb;
    makeEvent(db, { id: 1, name: 'A' });
    makeEvent(db, { id: 2, name: 'B' });
    await sync(db, RAW_REAL);
    const d = day(db, '2026-08-14');
    assert.equal(d.assign_status, 'ambiguous');
    assert.equal(d.bon_id, null);
    const flags = JSON.parse(d.flags_json);
    assert.ok(flags.some(f => f.code === 'ambiguous_event'));
});

/* ══════════════════════════════════════════════════════════
   BONNEN
   ══════════════════════════════════════════════════════════ */

test('med tilvalg bygges dagens salgsbon — BETALT, event-salg, POS-betaling', async () => {
    const db = _testDb;
    makeEvent(db);
    await sync(db, RAW_REAL);

    const d = day(db, '2026-08-14');
    assert.equal(d.assign_status, 'auto');
    assert.equal(d.event_id, 1);

    const bon = bonOf(db, '2026-08-14');
    assert.ok(bon, 'der skal være en bon');
    assert.equal(bon.event_role, 'sales');
    assert.equal(bon.payment_type, 'pos');
    assert.equal(bon.event_id, 1);
    assert.equal(bon.delivery_date, '2026-08-14');
    assert.equal(bon.is_internal, 0);
    const status = db.prepare('SELECT code FROM status_definitions WHERE id = ?').get(bon.status_id).code;
    assert.equal(status, 'BETALT');
    assert.equal(Math.round(bon.total_price * 100) / 100, d.gross_incl);
});

test('bonnen bærer event_id, så lager-gaten holder prep-bonnens træk i fred', async () => {
    const db = _testDb;
    makeEvent(db);
    await sync(db, RAW_REAL);
    const bon = bonOf(db, '2026-08-14');
    assert.equal(bon.event_id, 1, 'uden event_id ville et salg trække fra HQ');
    assert.equal(bon.inventory_deducted, 0, 'POS-synken trækker aldrig selv lager');
    assert.equal(db.prepare("SELECT price_category FROM bons WHERE id = ?").get(bon.id).price_category, 'festival');
});

test('linjerne bærer priser INCL moms, uden omregning', async () => {
    const db = _testDb;
    makeEvent(db);
    await sync(db, RAW_REAL);
    const bon = bonOf(db, '2026-08-14');
    const lines = linesOf(db, bon.id);
    assert.ok(lines.length > 0);
    for (const l of lines) assert.equal(l.moms_included, 1);
    const sum = Math.round(lines.reduce((s, l) => s + l.line_total, 0) * 100) / 100;
    assert.equal(sum, Math.round(bon.total_price * 100) / 100);
    const slider = lines.find(l => l.grocy_recipe_id === 57);
    assert.ok(slider, 'ordsæt-koblingen skal slå igennem til bon_lines');
    assert.equal(slider.category, '04 Slider');
    assert.equal(slider.cost_price, 11.2);
});

test('en vare uden Grocy-kobling kommer med som omsætning og listes som ukoblet', async () => {
    const db = _testDb;
    makeEvent(db);
    await sync(db, RAW_REAL);
    const bon = bonOf(db, '2026-08-14');
    const hotdog = linesOf(db, bon.id).find(l => /hotdog/i.test(l.product_name));
    assert.ok(hotdog, 'der SÆLGES ting der ikke ligger i Grocy');
    assert.equal(hotdog.grocy_recipe_id, null);
    assert.ok(JSON.parse(day(db, '2026-08-14').unmatched_json).some(u => /hotdog/i.test(u.name)));
});

/* ══════════════════════════════════════════════════════════
   RECONCILE, EJERSKAB, FRYS
   ══════════════════════════════════════════════════════════ */

test('en ny synk opdaterer den samme bon — der opstår ikke en til', async () => {
    const db = _testDb;
    makeEvent(db);
    await sync(db, RAW_REAL.slice(0, 2));
    const first = bonOf(db, '2026-08-14');
    const firstTotal = first.total_price;

    await sync(db, RAW_REAL);           // resten af dagens køb kom ind
    const after = bonOf(db, '2026-08-14');
    assert.equal(after.id, first.id, 'samme bon');
    assert.ok(after.total_price > firstTotal, 'med dagens fulde salg');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM bons').get().c, 1);
});

test('broen rører ALDRIG en bon den ikke selv har lavet', async () => {
    const db = _testDb;
    makeEvent(db);
    // Office har lavet sin egen salgsbon på samme event og dag.
    const loc = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get().id;
    const pc = db.prepare("SELECT id FROM price_categories WHERE code = 'festival'").get().id;
    const st = db.prepare("SELECT id FROM status_definitions WHERE code = 'BETALT'").get().id;
    db.prepare(`INSERT INTO bons (bon_number, status_id, location_id, price_category_id, price_category,
                event_id, event_role, order_date, delivery_date, delivery_type, pax, total_units, payment_type, total_price)
                VALUES ('T-MANUEL', ?, ?, ?, 'festival', 1, 'sales', '2026-08-14', '2026-08-14', 'event', 0, 0, 'cash', 4242)`)
        .run(st, loc, pc);

    await sync(db, RAW_REAL);
    const manual = db.prepare("SELECT * FROM bons WHERE bon_number = 'T-MANUEL'").get();
    assert.equal(manual.total_price, 4242, 'office-bonnen skal stå urørt');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM bon_lines WHERE bon_id = ?').get(manual.id).c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM bons').get().c, 2, 'POS laver sin egen ved siden af');
});

test('en bon der er ført videre fryser — og siger det højt', async () => {
    const db = _testDb;
    makeEvent(db);
    await sync(db, RAW_REAL.slice(0, 2));
    const bon = bonOf(db, '2026-08-14');
    const before = bon.total_price;
    setStatus(db, bon.id, 'FAKTURERET');

    await sync(db, RAW_REAL);
    const after = db.prepare('SELECT * FROM bons WHERE id = ?').get(bon.id);
    assert.equal(after.total_price, before, 'beløbet må ikke ændre sig under en faktureret bon');
    const flags = JSON.parse(day(db, '2026-08-14').flags_json);
    const frozen = flags.find(f => f.code === 'bon_frozen');
    assert.ok(frozen, 'og frysningen skal kunne ses — ikke bare ske');
    assert.equal(frozen.status, 'FAKTURERET');
});

test('en aflyst POS-bon spærrer ikke dagen for evigt', async () => {
    const db = _testDb;
    makeEvent(db);
    await sync(db, RAW_REAL.slice(0, 2));
    const first = bonOf(db, '2026-08-14');
    setStatus(db, first.id, 'AFLYST');

    await sync(db, RAW_REAL);
    const d = day(db, '2026-08-14');
    assert.notEqual(d.bon_id, first.id, 'der laves en frisk bon i stedet');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM bons').get().c, 2);
});

test('fjernes fluebenet EFTER at bonnen er lavet, mister dagen ikke sin kobling', async () => {
    // Ellers ville dagen stå som "uden event" mens bonnen levede videre — og
    // næste kobling ville lave en til. Bonnen skal håndteres først.
    const db = _testDb;
    makeEvent(db);
    await sync(db, RAW_REAL);
    const bon = bonOf(db, '2026-08-14');
    assert.ok(bon);

    db.prepare('UPDATE events SET pos_enabled = 0 WHERE id = 1').run();
    await sync(db, RAW_REAL);

    const d = day(db, '2026-08-14');
    assert.equal(d.event_id, 1, 'koblingen bliver stående så længe bonnen findes');
    assert.equal(d.bon_id, bon.id);
    const flags = JSON.parse(d.flags_json);
    assert.ok(flags.some(f => f.code === 'kept_assignment_bon_exists'), 'og det skal kunne ses');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM bons').get().c, 1);
});

/* ══════════════════════════════════════════════════════════
   MANUEL KOBLING
   ══════════════════════════════════════════════════════════ */

test('en glemt flueben rettes bagefter: kobl dagen i hånden → bonnen bygges', async () => {
    const db = _testDb;
    makeEvent(db, { posEnabled: 0 });
    await sync(db, RAW_REAL);
    assert.equal(bonOf(db, '2026-08-14'), null);

    const out = posSync.assignDay(db, '2026-08-14', 1, { recipes: RECIPES });
    assert.equal(out.assign.status, 'manual');
    const bon = bonOf(db, '2026-08-14');
    assert.ok(bon);
    assert.equal(bon.event_id, 1);
});

test('manuel kobling overlever en senere synk', async () => {
    const db = _testDb;
    makeEvent(db, { posEnabled: 0 });
    await sync(db, RAW_REAL);
    posSync.assignDay(db, '2026-08-14', 1, { recipes: RECIPES });
    await sync(db, RAW_REAL);
    const d = day(db, '2026-08-14');
    assert.equal(d.assign_status, 'manual');
    assert.equal(d.event_id, 1);
});

test('kobles dagen om, FLYTTES bonnen — der laves ikke en ny', async () => {
    const db = _testDb;
    makeEvent(db, { id: 1, name: 'A', posEnabled: 0 });
    makeEvent(db, { id: 2, name: 'B', posEnabled: 0 });
    await sync(db, RAW_REAL);
    posSync.assignDay(db, '2026-08-14', 1, { recipes: RECIPES });
    const bon = bonOf(db, '2026-08-14');

    posSync.assignDay(db, '2026-08-14', 2, { recipes: RECIPES });
    const after = bonOf(db, '2026-08-14');
    assert.equal(after.id, bon.id, 'samme bon');
    assert.equal(after.event_id, 2, 'flyttet til det andet event');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM bons').get().c, 1);
});

test('koblingen kan ikke fjernes mens bonnen findes — så ville næste synk lave en dublet', async () => {
    const db = _testDb;
    makeEvent(db);
    await sync(db, RAW_REAL);
    assert.ok(bonOf(db, '2026-08-14'));
    assert.throws(() => posSync.assignDay(db, '2026-08-14', null, { recipes: RECIPES }),
        e => e.code === 'bon_exists');
});

test('en frossen bon flyttes ikke automatisk', async () => {
    const db = _testDb;
    makeEvent(db, { id: 1, posEnabled: 0 });
    makeEvent(db, { id: 2, posEnabled: 0 });
    await sync(db, RAW_REAL);
    posSync.assignDay(db, '2026-08-14', 1, { recipes: RECIPES });
    setStatus(db, bonOf(db, '2026-08-14').id, 'AFSLUTTET');
    assert.throws(() => posSync.assignDay(db, '2026-08-14', 2, { recipes: RECIPES }),
        e => e.code === 'bon_frozen');
});

/* ══════════════════════════════════════════════════════════
   PRODUKTKOBLING
   ══════════════════════════════════════════════════════════ */

test('manuel produktkobling slår igennem på bonnen ved genopbygning', async () => {
    const db = _testDb;
    makeEvent(db);
    await sync(db, RAW_REAL);
    const uuid = normalizePurchase(RAW_REAL.find(r => /hotdog/i.test(JSON.stringify(r))))
        .lines.find(l => /hotdog/i.test(l.name)).product_uuid;

    db.prepare(`INSERT INTO pos_product_map (source, pos_product_uuid, grocy_recipe_id, name_seen)
                VALUES ('zettle', ?, 11, 'Luxus hotdog')`).run(uuid);
    posSync.rebuildDay(db, '2026-08-14', { recipes: RECIPES });

    const hotdog = linesOf(db, bonOf(db, '2026-08-14').id).find(l => /hotdog/i.test(l.product_name));
    assert.equal(hotdog.grocy_recipe_id, 11);
    assert.equal(hotdog.cost_price, 24.0);
    assert.equal(JSON.parse(day(db, '2026-08-14').unmatched_json).some(u => /hotdog/i.test(u.name)), false);
});

/* ══════════════════════════════════════════════════════════
   GROCY NEDE
   ══════════════════════════════════════════════════════════ */

test('er Grocy nede, gemmes købene — men der bygges ingen halv bon', async () => {
    const db = _testDb;
    makeEvent(db);
    const r = await posSync.syncPos(db, {
        adapter: stubAdapter(RAW_REAL),
        from: '2026-08-13', to: '2026-08-16',
        deps: {
            getRecipes: async () => { throw new Error('Grocy utilgængelig'); },
            todayISO: () => '2026-08-16', offsetISO: () => '2026-08-13',
        },
    });
    assert.equal(r.ok, true);
    assert.equal(r.recipes_available, false);
    assert.ok(db.prepare('SELECT COUNT(*) c FROM pos_purchases').get().c > 0, 'købene er gemt');
    assert.equal(bonOf(db, '2026-08-14'), null, 'hellere ingen bon end en vi ved er mangelfuld');
    assert.match(day(db, '2026-08-14').last_error, /Grocy/);

    // Og når Grocy er tilbage, bygges den uden at der skal hentes igen.
    posSync.rebuildDay(db, '2026-08-14', { recipes: RECIPES });
    assert.ok(bonOf(db, '2026-08-14'));
    assert.equal(day(db, '2026-08-14').last_error, null);
});

/* ══════════════════════════════════════════════════════════
   SSE
   ══════════════════════════════════════════════════════════ */

test('bon_created og event_updated udsendes, så skærmene følger med', async () => {
    const db = _testDb;
    makeEvent(db);
    _events.length = 0;
    await sync(db, RAW_REAL);
    assert.ok(_events.some(e => e.name === 'bon_created'));
    assert.ok(_events.some(e => e.name === 'event_updated'));
    const created = _events.find(e => e.name === 'bon_created');
    assert.ok(created.payload.id, 'bon_*-events bruger {id} (Patch F-konventionen)');
});
