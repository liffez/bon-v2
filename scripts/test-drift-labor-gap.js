// scripts/test-drift-labor-gap.js
// ============================================================
// En dag med produktion, men uden vagter, må ikke se rentabel ud.
//
// Værnet mod at fryse en dag uden løn (#320-runden) fanger kun når vagtplanen
// FEJLER. Et tomt-men-vellykket svar er ingen fejl — og så fryses 0 kr stille.
//
// Målt i drift 25. august 2026: 20.-31. juli har ingen vagter overhovedet,
// mens 30. juli producerede 810 enheder. Worklogs opstår først når en vagt er
// godkendt i Smartplan, og planlagte vagter hentes kun fremad; en fortidig vagt
// der aldrig blev godkendt er derfor usynlig for begge endpoints. Juli havde 10
// dage med vagter mod 22-28 i de øvrige måneder.
//
// Vi spærrer ikke — tomt KAN være rigtigt. Men det skal stå på skærmen.
//
// Kør:  node --experimental-sqlite scripts/test-drift-labor-gap.js
// ============================================================

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const TEST_DB = path.join(os.tmpdir(), `bon-test-laborgap-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  \x1b[32m✓\x1b[0m', msg); pass++; }
    else      { console.log('  \x1b[31m✗\x1b[0m', msg); fail++; }
}

// Vagtplanen styres pr. dato, så både "tom" og "fejler" kan fremprovokeres.
let laborByDate = {};
let laborThrows = false;
const lPath = require.resolve('../services/laborAdapter');
require.cache[lPath] = {
    id: lPath, filename: lPath, loaded: true, exports: {
        getLabor: async (d) => {
            if (laborThrows) throw new Error('Smartplan svarer ikke');
            return (laborByDate[d] || []).map(r => ({ ...r }));
        },
        getLaborMap: async () => {
            if (laborThrows) throw new Error('Smartplan svarer ikke');
            return Object.fromEntries(Object.entries(laborByDate).map(([k, v]) => [k, v.map(r => ({ ...r }))]));
        },
    },
};

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { userId: 1, userRole: 'admin' }; next(); });
app.use('/api/drift', require('../routes/drift'));

let server, BASE;
const get = async (u) => (await (await fetch(BASE + u)).json());

const { offsetISO } = require('../db/helpers');
const ARBEJDSDAG = offsetISO(120);   // fremtid → altid live, ingen frysning i vejen
const STILLE_DAG = offsetISO(121);
const FEJL_DAG   = offsetISO(122);

const vagt = () => ({
    employee_id: 'u1', employee_name: 'Kok', role_class: 'production', is_open: false,
    location: 'Ristet Rug', location_class: 'hq', timer: 8, sats: 150, kostpris: 1200,
    rate_missing: false, role_unmapped: false, mode: 'realiseret',
});

function seedBon(db, dato, { units }) {
    const st = (c) => db.prepare('SELECT id FROM status_definitions WHERE code=?').get(c).id;
    const pc = (c) => db.prepare('SELECT id FROM price_categories WHERE code=?').get(c)?.id;
    const id = Number(db.prepare(`
        INSERT INTO bons (bon_number, status_id, location_id, order_date, delivery_date,
                          price_category_id, total_price, pax)
        VALUES (?,?,1,?,?,?,?,10)
    `).run(`T_GAP_${dato}`, st('BETALT'), dato, dato, pc('catering') ?? null, units * 100).lastInsertRowid);
    db.prepare(`INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit, unit_price, line_total, cost_price)
                VALUES (?,'Tunen','01 Sandwich',?,'stk',100,?,25)`).run(id, units, units * 100);
}

async function main() {
    const { getDb } = require('../db/database');
    const db = getDb();
    seedBon(db, ARBEJDSDAG, { units: 810 });     // produktion, men ingen vagter
    seedBon(db, FEJL_DAG,   { units: 100 });
    // STILLE_DAG får bevidst INGEN bon: ingen produktion, ingen vagter.

    await new Promise(r => { server = app.listen(0, () => { BASE = `http://localhost:${server.address().port}`; r(); }); });
    const day = (d) => get(`/api/drift/day?date=${d}&mode=realiseret`);

    console.log('\n— Produktion uden vagter siges højt —');
    laborByDate = {};
    const a = await day(ARBEJDSDAG);
    assert(a.labor_none_despite_activity === true,
        '810 enheder og nul vagter → markeret');
    assert(!a.labor_error, '…og det er IKKE en fejl — vagtplanen svarede fint');
    assert(a.labor_ex_moms === 0, 'lønnen er 0 kr, som den jo er');

    console.log('\n— En dag hvor der ikke skete noget, råbes der ikke op om —');
    const b = await day(STILLE_DAG);
    assert(b.labor_none_despite_activity === false,
        'ingen produktion + ingen vagter → ingen markering');

    console.log('\n— Vagter til stede: intet at sige —');
    laborByDate = { [ARBEJDSDAG]: [vagt()] };
    const c = await day(ARBEJDSDAG);
    assert(c.labor_none_despite_activity === false, 'med vagter er der ingen markering');
    assert(c.labor_raw_ex_moms === 1200, '…og lønnen er med');

    console.log('\n— En FEJL er noget andet end et tomt svar —');
    // De to må ikke se ens ud: den ene retter sig selv når kilden svarer igen,
    // den anden gør ikke. Derfor hver sin markering og hver sin forklaring.
    laborByDate = {};
    laborThrows = true;
    const d = await day(FEJL_DAG);
    assert(!!d.labor_error, 'fejlen står på svaret');
    assert(d.labor_none_despite_activity === false,
        '…og dagen markeres IKKE som hul — årsagen er en anden');
    laborThrows = false;

    console.log('\n— Perioden tæller hullerne —');
    const p = await get(`/api/drift/period?from=${ARBEJDSDAG}&to=${FEJL_DAG}&mode=realiseret`);
    // Præcis HVILKE dage, ikke bare hvor mange: både arbejdsdagen og fejl-dagen
    // har produktion uden vagter (fejlen er væk nu), mens den stille dag hverken
    // har det ene eller det andet. Et rent antal ville bestå selvom den forkerte
    // dag blev markeret.
    const huller = (p.days || []).filter(x => x.labor_none_despite_activity).map(x => x.date).sort();
    assert(huller.join(',') === [ARBEJDSDAG, FEJL_DAG].sort().join(','),
        `hullerne er arbejdsdagen og fejl-dagen (fik ${huller.join(',') || 'ingen'})`);
    assert(!huller.includes(STILLE_DAG), 'og IKKE den stille dag, hvor der intet skete');
    assert(p.labor_gap_days === huller.length, `tælleren stemmer med listen (${p.labor_gap_days})`);
}

main()
    .catch(err => { console.error(err); fail++; })
    .finally(() => {
        if (server) server.close();
        for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(TEST_DB + suf); } catch {} }
        console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} pass · ${fail} fail\x1b[0m`);
        process.exit(fail === 0 ? 0 : 1);
    });
