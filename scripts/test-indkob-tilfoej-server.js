// scripts/test-indkob-tilfoej-server.js
// ============================================================
// Hvor mængden lander når man lægger en vare på indkøbslisten igen.
//
// REGRESSIONEN er drifts-scenariet: 10 kasser handsker bestilt hos Serviwet,
// og så vil man bestille 5 mere. Man fik en grøn toast, men varen dukkede
// aldrig op som klar til bestilling.
//
// Grocys /stock/shoppinglist/add-product lægger mængden til en EKSISTERENDE
// linje når (product_id, list_id, note) matcher — og den tager den første der
// passer, typisk den bestilte. Om det sker, afhang af om linjen tilfældigvis
// havde en note: målt mod grocy-test aggregerede handskerne (ingen note) mens
// burgerlommerne (note fra en tidligere synk) fik en ny linje. Den slags må
// ikke afgøre om man kan bestille.
//
// Reglen bor i routen, ikke i klienten, så ingen kaldevej kan glemme den:
//
//   ingen bestilte linjer  → Grocys egen aggregering (rigtigt: læg til det åbne)
//   bestilt + åben         → læg til den ÅBNE linje
//   alle bestilte          → opret en NY linje
//
// Adapteren stubbes, så de tre veje kan skilles ad uden at røre Grocy.
//
//   node --experimental-sqlite scripts/test-indkob-tilfoej-server.js
// ============================================================
'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');
const http = require('http');

const TEST_DB = path.join(os.tmpdir(), `bon-test-tilfoej-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;
// §7 kalder den ÆGTE adapter mod en falsk fetch. getGrocyConfig kræver en
// nøgle for overhovedet at bygge kaldet; den bruges aldrig, for intet går ud.
process.env.GROCY_TEST_KEY = 'test-nøgle-bruges-ikke';
process.env.GROCY_TEST_URL = 'https://grocy.invalid/api';

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${m}`); c ? pass++ : fail++; };
const eq = (a, b, m) => ok(a === b, `${m} — fik ${JSON.stringify(a)}`);

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

// Adapteren stubbes FØR routen loades.
const adapterPath = require.resolve('../services/grocyAdapter');
const ægte = require('../services/grocyAdapter');
const G = {
    liste: [],
    kald: [],
    fejlPåListe: false,
};
require.cache[adapterPath] = {
    id: adapterPath, filename: adapterPath, loaded: true,
    exports: Object.assign(Object.create(null), ægte, {
        getShoppingList: async () => {
            if (G.fejlPåListe) throw new Error('Grocy nede');
            return G.liste;
        },
        getProducts: async () => ([{ id: 94, name: 'Engangshandsker - M', qu_id_purchase: 13, qu_id_stock: 8 }]),
        addShoppingListProduct: async (pid, amount) => { G.kald.push({ vej: 'grocy', pid, amount }); },
        createShoppingListLine: async (pid, amount, listId, quId) => {
            G.kald.push({ vej: 'ny', pid, amount, quId });
        },
        updateShoppingListItem: async (id, fields) => { G.kald.push({ vej: 'opdater', id, fields }); },
    }),
};

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { userId: 1, userRole: 'admin' }; next(); });
app.use('/api/grocy', require('../routes/grocy'));
const server = http.createServer(app);

function post(sti, body) {
    return new Promise((res, rej) => {
        const data = JSON.stringify(body);
        const r = http.request({
            host: '127.0.0.1', port: server.address().port, path: sti, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (svar) => {
            let b = ''; svar.on('data', c => b += c);
            svar.on('end', () => res({ status: svar.statusCode, body: b ? JSON.parse(b) : null }));
        });
        r.on('error', rej); r.write(data); r.end();
    });
}

const BESTILT = { ordered_at: '2026-09-22T08:00:00Z', ordered_varenr: '4711' };

async function læg(linjer, amount) {
    G.liste = linjer; G.kald = [];
    const r = await post('/api/grocy/shopping-list/add-product',
                         { product_id: 94, product_amount: amount, list_id: 1 });
    return { r, kald: G.kald };
}

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));

    console.log('\n=== §1 Varen er slet ikke på listen ===');
    let t = await læg([], 5);
    eq(t.r.body && t.r.body.path, 'grocy', 'Grocys egen tilføjelse bruges');
    eq(t.kald.length, 1, 'ét kald');

    console.log('\n=== §2 Varen er på listen, intet bestilt ===');
    t = await læg([{ id: 1, product_id: 94, amount: 10, userfields: {} }], 5);
    eq(t.r.body && t.r.body.path, 'grocy',
       'Grocys aggregering er rigtig her — mængden lægges til det man vil bestille');
    eq(t.kald[0] && t.kald[0].vej, 'grocy', 'og vi rører ikke linjen selv');

    console.log('\n=== §3 Alt er bestilt (drifts-scenariet) ===');
    t = await læg([{ id: 1, product_id: 94, amount: 10, userfields: BESTILT }], 5);
    eq(t.r.body && t.r.body.path, 'new_line',
       'der oprettes en NY linje — ellers forsvinder de 5 ind i den bestilte');
    eq(t.kald[0] && t.kald[0].vej, 'ny', 'gennem den direkte oprettelse');
    eq(t.kald[0] && t.kald[0].amount, 5, 'med den tilføjede mængde');
    eq(t.kald[0] && t.kald[0].quId, 13, 'og produktets købsenhed');
    ok(!t.kald.some(k => k.vej === 'grocy'),
       'Grocys add-product bruges IKKE — den ville ramme den bestilte linje');

    console.log('\n=== §4 Både bestilt og åben ===');
    t = await læg([
        { id: 1, product_id: 94, amount: 10, userfields: BESTILT },
        { id: 2, product_id: 94, amount: 5,  userfields: {} },
    ], 3);
    eq(t.r.body && t.r.body.path, 'merged', 'mængden lægges til den ÅBNE linje');
    eq(t.kald[0] && t.kald[0].id, 2, 'og det er den åbne (id 2), ikke den bestilte');
    eq(t.kald[0] && t.kald[0].fields && t.kald[0].fields.amount, 8, '5 + 3 = 8');
    ok(!t.kald.some(k => k.vej === 'grocy'),
       'Grocy vælger ikke selv — den tager den første match, typisk den bestilte');

    console.log('\n=== §5 Andre varers linjer blander sig ikke ===');
    t = await læg([
        { id: 9, product_id: 73, amount: 99, userfields: BESTILT },   // en ANDEN vare
        { id: 1, product_id: 94, amount: 10, userfields: {} },
    ], 5);
    eq(t.r.body && t.r.body.path, 'grocy',
       'en anden vares bestilte linje gør ikke DENNE vare bestilt');

    console.log('\n=== §6 Kan listen ikke læses ===');
    G.fejlPåListe = true;
    t = await læg([{ id: 1, product_id: 94, amount: 10, userfields: BESTILT }], 5);
    G.fejlPåListe = false;
    eq(t.r.status, 200, 'tilføjelsen afvises ikke fordi vi ikke kunne læse listen');
    eq(t.kald[0] && t.kald[0].vej, 'grocy', 'vi falder tilbage til Grocys egen adfærd');

    console.log('\n=== §7 Payloadet til Grocy ===');
    // Adapteren er stubbet ovenfor, så den ÆGTE createShoppingListLine køres
    // ikke af §3. Feltnavnet er præcis dét der gav 400 mod den rigtige Grocy:
    // kolonnen hedder shopping_list_id på objektet, ikke list_id (som kun er
    // navnet i /stock/shoppinglist/add-product's payload).
    const globalFetch = globalThis.fetch;
    let sendt = null;
    globalThis.fetch = async (url, opts) => {
        sendt = { url: String(url), body: JSON.parse(opts.body) };
        return {
            ok: true, status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ created_object_id: 1 }),
            text: async () => '{"created_object_id":1}',
        };
    };
    try {
        await ægte.createShoppingListLine(94, 5, 1, 13);
    } catch (e) {
        ok(false, 'createShoppingListLine kastede: ' + e.message);
    } finally {
        globalThis.fetch = globalFetch;
    }
    ok(!!sendt && /\/objects\/shopping_list$/.test(sendt.url),
       'der POSTes til /objects/shopping_list');
    eq(sendt && sendt.body.shopping_list_id, 1,
       'listen hedder shopping_list_id — list_id gav 400 fra Grocy');
    ok(!!sendt && !('list_id' in sendt.body), 'og list_id sendes ikke');
    eq(sendt && sendt.body.product_id, 94, 'produktet er med');
    eq(sendt && sendt.body.amount, 5, 'og mængden');
    eq(sendt && sendt.body.qu_id, 13, 'og enheden');

    console.log('\n=== §8 Validering ===');
    const u = await post('/api/grocy/shopping-list/add-product', { product_amount: 5 });
    eq(u.status, 400, 'uden product_id afvises kaldet');

    server.close();
    console.log(`\n${pass} PASS · ${fail} FAIL`);
    try { fs.unlinkSync(TEST_DB); } catch (_) {}
    process.exit(fail ? 1 : 0);
})();
