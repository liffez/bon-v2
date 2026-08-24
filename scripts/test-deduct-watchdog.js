// scripts/test-deduct-watchdog.js
// ============================================================
// Vagthundens afgrænsning (#305, #359).
//
// Kontrollen fandt tre "manglende lagertræk" i drift 9. august 2026. Ingen af dem
// var lagerfejl:
//
//   • cafe-3320 har leveringsdato 2027-03-04 og NUL varelinjer. Den blev rapporteret
//     hver eneste dag, og ville være blevet ved i syv måneder.
//   • Vinduet havde ingen øvre grænse — beskeden sagde "de seneste 3 dage", men
//     forespørgslen fangede alt fra tre dage siden og FREM.
//
// En alarm der melder det samme hver dag om noget der ikke er galt, bliver holdt
// op med at blive læst — og så overses den ægte. Præcis det svigt som vagthunden
// selv blev bygget efter (#305).
//
// Testen kalder de EKSPORTEREDE funktioner, så den rammer den rigtige SQL mod det
// rigtige skema. Isoleret temp-DB; rører hverken drift eller Grocy.
//
//   node --experimental-sqlite scripts/test-deduct-watchdog.js
// ============================================================
'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { spawnSync } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-test-watchdog-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const { getDb } = require('../db/database');
const { findUndeducted, findPartial, findNothingToDeduct } =
    require('./check-inventory-deduct.js');

let pass = 0, fail = 0;
const check = (c, m) => { console.log(`  ${c ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${m}`); c ? pass++ : fail++; };

const db = getDb();
const statusId = code =>
    db.prepare('SELECT id FROM status_definitions WHERE code = ?').get(code)?.id;

// Datoer relativt til i dag, så testen ikke rådner. `offsetISO` er den samme
// helper produktionskoden bruger — ingen toISOString-fælde (jf. CLAUDE.md).
const { offsetISO, todayISO } = require('../db/helpers');

const LOCATION_ID = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get()?.id;

let seq = 0;
function mkBon({ status = 'LEVERET', date, deducted = 0, deductStatus = null,
                 isOffer = 0, withRecipeLine = true, sawLeveret = false, otherStatusChange = null }) {
    const num = `T_WD_${++seq}`;
    const r = db.prepare(`
        INSERT INTO bons (bon_number, order_date, delivery_date, status_id,
                          inventory_deducted, inventory_deduct_status, is_offer, location_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(num, todayISO(), date, statusId(status), deducted, deductStatus, isOffer, LOCATION_ID);
    const id = r.lastInsertRowid;
    if (withRecipeLine) {
        db.prepare(`
            INSERT INTO bon_lines (bon_id, product_name, quantity, grocy_recipe_id)
            VALUES (?, 'Testvare', 1, 42)
        `).run(id);
    }
    for (const v of [sawLeveret ? 'LEVERET' : null, otherStatusChange]) {
        if (!v) continue;
        db.prepare(`
            INSERT INTO changelog (entity_type, entity_id, action, field_name, new_value)
            VALUES ('bon', ?, 'status_change', 'status_id', ?)
        `).run(id, v);
    }
    return { id, num };
}
const nums = rows => rows.map(r => r.bon_number).sort();

console.log('\n\x1b[1mDrifts-tilfældet: de tre falske alarmer\x1b[0m');

// cafe-3320: fremtidig dato OG ingen linjer — begge grunde til ikke at alarmere.
const cafe = mkBon({ status: 'AFSLUTTET', date: offsetISO(200), withRecipeLine: false });
check(!nums(findUndeducted(db, 3)).includes(cafe.num),
    'bon uden varelinjer og med fremtidig dato alarmerer ikke (cafe-3320)');

// B4152/B4153: fremtidig leveringsdato, allerede sat til BETALT.
const fremtid = mkBon({ status: 'BETALT', date: offsetISO(25) });
check(!nums(findUndeducted(db, 3)).includes(fremtid.num),
    'fremtidig levering alarmerer ikke — den er ikke sket endnu');

console.log('\n\x1b[1mDe ægte fejl skal stadig frem\x1b[0m');

const iGaar = mkBon({ status: 'LEVERET', date: offsetISO(-1) });
check(nums(findUndeducted(db, 3)).includes(iGaar.num),
    'leveret i går uden træk alarmerer');

const iDag = mkBon({ status: 'LEVERET', date: todayISO() });
check(nums(findUndeducted(db, 3)).includes(iDag.num),
    'leveret i dag uden træk alarmerer (den øvre grænse er inklusiv)');

const fejlet = mkBon({ status: 'LEVERET', date: offsetISO(-1), deductStatus: 'failed' });
check(nums(findUndeducted(db, 3)).includes(fejlet.num),
    "status 'failed' alarmerer");

// Et forsøgt og mislykket træk skal frem uanset dato — ellers ville en bon der
// blev leveret før tid ligge stille indtil dens leveringsdato indtraf.
const fejletFremtid = mkBon({ status: 'LEVERET', date: offsetISO(2), deductStatus: 'failed' });
check(nums(findUndeducted(db, 3)).includes(fejletFremtid.num),
    "'failed' alarmerer også når leveringsdatoen ligger frem i tiden");

console.log('\n\x1b[1mAfgrænsninger der var der i forvejen\x1b[0m');

const gammel = mkBon({ status: 'LEVERET', date: offsetISO(-30) });
check(!nums(findUndeducted(db, 3)).includes(gammel.num),
    'uden for vinduet (30 dage siden) alarmerer ikke');

const trukket = mkBon({ status: 'LEVERET', date: offsetISO(-1), deducted: 1, deductStatus: 'ok' });
check(!nums(findUndeducted(db, 3)).includes(trukket.num),
    'bon der HAR trukket alarmerer ikke');

const tilbud = mkBon({ status: 'LEVERET', date: offsetISO(-1), isOffer: 1 });
check(!nums(findUndeducted(db, 3)).includes(tilbud.num),
    'tilbud alarmerer ikke');

console.log('\n\x1b[1mIntet at trække: talt, ikke skjult\x1b[0m');

const tom = mkBon({ status: 'LEVERET', date: offsetISO(-1), withRecipeLine: false });
check(!nums(findUndeducted(db, 3)).includes(tom.num),
    'bon uden opskriftskoblede linjer alarmerer ikke');
check(nums(findNothingToDeduct(db, 3)).includes(tom.num),
    'men den TÆLLES som "intet at trække" — forsvinder ikke sporløst');
check(!nums(findNothingToDeduct(db, 3)).includes(iGaar.num),
    '… og en bon med opskriftslinjer havner ikke i den kategori');

// En linje UDEN grocy_recipe_id kan heller ikke trækkes — fritekst-linjer tæller ikke.
const kunFritekst = mkBon({ status: 'LEVERET', date: offsetISO(-1), withRecipeLine: false });
db.prepare(`INSERT INTO bon_lines (bon_id, product_name, quantity) VALUES (?, 'Fritekst', 1)`)
    .run(kunFritekst.id);
check(!nums(findUndeducted(db, 3)).includes(kunFritekst.num),
    'linje uden opskriftskobling tæller ikke som noget der kan trækkes');

console.log('\n\x1b[1mDelvise træk (#359) — uændret\x1b[0m');

const delvis = mkBon({ status: 'LEVERET', date: offsetISO(-1), deducted: 1, deductStatus: 'partial' });
check(nums(findPartial(db, 3)).includes(delvis.num),
    'delvist træk fanges af findPartial');
check(!nums(findUndeducted(db, 3)).includes(delvis.num),
    '… og dukker ikke også op som manglende træk (flaget er sat)');

// ── Exit-koden er selve alarmen ─────────────────────────────────────────────
//
// Cron reagerer på exit-koden, ikke på loggen. Dækningen lå tidligere i
// `scripts/test-deduct-check.js`, som var rådnet på sine fixtures (den
// seedede bons uden opskriftslinjer og med datoer uden for vinduet, så
// forespørgslen med rette fandt ingenting). Den er slettet, og det den
// faktisk prøvede — barn-processen og koderne — er flyttet herned.
console.log('\n\x1b[1mExit-koden, via barn-proces\x1b[0m');

const setSetting = (k, v) => db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);

function koer() {
    const r = spawnSync('node', ['--experimental-sqlite', path.join(__dirname, 'check-inventory-deduct.js')], {
        env: { ...process.env, DB_PATH: TEST_DB, INVENTORY_CHECK_DAYS: '3', INVENTORY_ALERT_EMAIL: '' },
        encoding: 'utf8',
    });
    return { code: r.status, ud: (r.stdout || '') + (r.stderr || '') };
}

// Slukket lagertræk er en KENDT tilstand, ikke en alarm — ellers ville
// kontrollen råbe hver nat i et hus der bevidst har slået det fra.
setSetting('inventory_auto_deduct', '0');
let r = koer();
check(r.code === 0, `flag slukket → exit 0 (fik ${r.code})`);
check(/slukket/.test(r.ud), 'og loggen siger hvorfor der ikke alarmeres');

// Tændt, og der ER drift (de bons ovenfor står stadig i basen).
setSetting('inventory_auto_deduct', '1');
r = koer();
check(r.code === 1, `drift fundet → exit 1, så cron fanger det (fik ${r.code})`);
check(/ALDRIG passeret LEVERET/.test(r.ud), 'og årsagen står i outputtet, ikke kun antallet');
check(/ingen alarm-modtager/.test(r.ud), 'uden modtager noteres det — mailen springes over, alarmen består');

// Oprydning: temp-DB slettes uanset udfald.
try { fs.unlinkSync(TEST_DB); } catch {}

// ── Alarmen skal sige HVORFOR ───────────────────────────────────────────────
//
// Drifts-tilfældet 24.08: #B4202 og #B4207 stod som BETALT uden træk og uden
// `inventory_deduct_status`. Alarmen kunne kun sige AT de ikke havde trukket.
// De tre årsager kræver hver sin handling, og forskellen er om bonen
// nogensinde passerede LEVERET — trækket udløses kun dér.
console.log('\n\x1b[1mAlarmen skal kunne sige hvorfor\x1b[0m');

// Bonen HAR statusskift i changelog — bare ikke til LEVERET. Uden dette
// tilfælde består testen selvom man kun tjekker "findes der et statusskift",
// og så beviser den ingenting. (Mutationen slap først igennem her.)
const sprangForbi = mkBon({ status: 'BETALT', date: offsetISO(-1),
                            sawLeveret: false, otherStatusChange: 'FAKTURERET' });
const varLeveret  = mkBon({ status: 'BETALT', date: offsetISO(-1), sawLeveret: true });
const fejlede     = mkBon({ status: 'LEVERET', date: offsetISO(-1), deductStatus: 'failed', sawLeveret: true });

const fund = findUndeducted(db, 3);
const find = (n) => fund.find(r => r.bon_number === n);

check(find(sprangForbi.num)?.saw_leveret === 0,
    'en bon der aldrig passerede LEVERET mærkes som sådan — trækket kunne ikke være kørt');
check(find(varLeveret.num)?.saw_leveret === 1,
    'en bon der HAR passeret LEVERET kendes fra den — dér skal serverloggen undersøges');
check(find(fejlede.num)?.inventory_deduct_status === 'failed',
    'og et forsøgt-men-fejlet træk bærer stadig sin status');

console.log(`\n${'─'.repeat(50)}\n${pass} PASS · ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
