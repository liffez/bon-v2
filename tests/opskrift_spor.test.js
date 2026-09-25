// tests/opskrift_spor.test.js
// ============================================================
// Ændringer på en opskrift efterlader et spor i Bon (#683).
//
// #666 gav produkterne et spor. Opskrifterne havde intet — og det er dér
// UDBYTTET bor, som er divisoren i kostprisen for den vare opskriften
// producerer (`recipeCost.lineUnitCost`). #680 er historien om at netop det
// felt blev overskrevet på otte opskrifter af et Gem der ikke bad om det,
// uden at nogen kunne se det bagefter.
//
// Testen rammer den ÆGTE `/api/opskrifter/:id/gem` over HTTP. Grocy stubbes;
// changelog er en rigtig tabel bygget af de rigtige migrations. Et spejl af
// reglerne her ville kunne drive fra ruten uden at én eneste assert faldt.
//
// Kør: node --experimental-sqlite --test tests/opskrift_spor.test.js
// ============================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbModule = require('../db/database');
let _db = null;
dbModule.getDb = () => _db;
require('../shared/sse').broadcast = () => {};

/* ── Grocy-stub ────────────────────────────────────────────────
   Opskrift 1 «Rødkål - Syltet» producerer vare 50 «Rødkål-Sylt» og bruger
   to varer + én underopskrift. Vare 50 bruges af to ANDRE opskrifter — det
   er dem advarslen og `used_by` handler om.                                */
const G = {};
function nulstilGrocy() {
    G.recipes = [
        { id: 1, name: 'Rødkål - Syltet', base_servings: 1, description: '<p>Skær kålen</p>',
          product_id: 50, userfields: { grupper: 'RR Produktion', recipeunit: 'Kilo', recipeunitnumber: '1' } },
        { id: 2, name: 'Grisen på Rug', base_servings: 1, description: '', product_id: null, userfields: { grupper: '01 Sandwich' } },
        { id: 3, name: 'Frikadellen',   base_servings: 1, description: '', product_id: null, userfields: { grupper: '01 Sandwich' } },
        { id: 9, name: 'Lage',          base_servings: 1, description: '', product_id: null, userfields: {} },
    ];
    G.pos = [
        { id: 101, recipe_id: 1, product_id: 20, amount: 2.7,  qu_id: 1, ingredient_group: null, note: null },
        { id: 102, recipe_id: 1, product_id: 21, amount: 0.06, qu_id: 1, ingredient_group: null, note: null },
        // Vare 50 (det opskrift 1 producerer) bruges af to andre retter.
        { id: 201, recipe_id: 2, product_id: 50, amount: 0.03, qu_id: 1, ingredient_group: null, note: null },
        { id: 202, recipe_id: 3, product_id: 50, amount: 0.02, qu_id: 1, ingredient_group: null, note: null },
    ];
    G.nestings = [{ id: 301, recipe_id: 1, includes_recipe_id: 9, servings: 2 }];
    G.products = [
        { id: 20, name: 'Rødkål',    qu_id_stock: 1, qu_id_purchase: 1 },
        { id: 21, name: 'Balsamico', qu_id_stock: 1, qu_id_purchase: 1 },
        { id: 50, name: 'Rødkål-Sylt', qu_id_stock: 1, qu_id_purchase: 1 },
        { id: 60, name: 'Hvidkål',   qu_id_stock: 1, qu_id_purchase: 1 },
    ];
    G.skrevet = [];      // hvert kald til Grocy, i rækkefølge
    G.skrivFejl = null;
}
const grocyStub = {
    getRecipesRaw: async () => G.recipes.map(r => ({ ...r })),
    getAllRecipesPos: async () => G.pos.map(p => ({ ...p })),
    getRecipeNestings: async () => G.nestings.map(n => ({ ...n })),
    getProducts: async () => G.products.map(p => ({ ...p })),
    getQuantityUnits: async () => [{ id: 1, name: 'Kilo' }, { id: 2, name: 'Antal' }],
    getQuantityUnitConversions: async () => [],
    getProductGroups: async () => [],
    getProductUnitCostDetails: async () => new Map(),
    getLocations: async () => [{ id: 2, name: 'Køl' }],
    updateRecipe: async (id, body) => { if (G.skrivFejl) throw new Error(G.skrivFejl); G.skrevet.push(['recipe', id, body]); },
    updateRecipeUserfields: async (id, body) => { if (G.skrivFejl) throw new Error(G.skrivFejl); G.skrevet.push(['uf', id, body]); },
    updateRecipePos: async (id, body) => { G.skrevet.push(['posPut', id, body]); },
    createRecipePos: async (body) => { G.skrevet.push(['posPost', body]); return { created_object_id: 999 }; },
    deleteRecipePos: async (id) => { G.skrevet.push(['posDel', id]); },
    updateRecipeNesting: async (id, body) => { G.skrevet.push(['nestPut', id, body]); },
    createRecipeNesting: async (body) => { G.skrevet.push(['nestPost', body]); return { created_object_id: 998 }; },
    deleteRecipeNesting: async (id) => { G.skrevet.push(['nestDel', id]); },
    createRecipe: async (body) => { G.skrevet.push(['recipeNew', body]); return { created_object_id: 77 }; },
    invalidateAllRecipeCosts: () => {},
};
const grocyPath = require.resolve('../services/grocyAdapter');
require.cache[grocyPath] = {
    id: grocyPath, filename: grocyPath, loaded: true,
    exports: new Proxy(grocyStub, { get: (t, k) => (k in t ? t[k] : async () => []) }),
};

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
function nyDb() {
    const db = new DatabaseSync(':memory:');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
    db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(7, 'Anne');
    db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(8, 'Leif');
    return db;
}

const express = require('express');
const recipeDraft = require('../services/recipeDraft');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { userId: 7, userRole: 'kitchen' }; next(); });
app.use('/api/opskrifter', require('../routes/opskrifter'));

let server, base;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => new Promise(r => server.close(r)));
test.beforeEach(() => { _db = nyDb(); nulstilGrocy(); });

async function post(sti, body, kilde) {
    const headers = { 'Content-Type': 'application/json' };
    if (kilde) headers['X-Bon-Kilde'] = kilde;
    const r = await fetch(base + sti, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
}
async function get(sti) {
    const r = await fetch(base + sti);
    return { status: r.status, body: await r.json() };
}

/** Kladden som den ligger i Grocy — udgangspunktet for hvert gem. */
async function gemtKladde(id = 1) {
    return recipeDraft.draftFromSaved(id, await recipeDraft.loadGrocy());
}
function spor() {
    return _db.prepare(
        `SELECT field_name, old_value, new_value, notes, user_id, action
         FROM changelog WHERE entity_type = 'grocy_recipe' ORDER BY id`).all();
}
const felt = (navn) => spor().filter(r => r.field_name === navn);

/* ══════════════════════════════════════════════════════════════
   §1 — Udbyttet er det der skal kunne ses bagefter
   ══════════════════════════════════════════════════════════════ */

test('§1.1 et ændret udbytte står i sporet med før → efter', async () => {
    const k = await gemtKladde();
    k.yield.amount = 1.4;
    const r = await post('/api/opskrifter/1/gem', k, 'opskrift-editor');
    assert.equal(r.status, 200);
    assert.equal(r.body.wrote, true);

    const u = felt('recipeunitnumber');
    assert.equal(u.length, 1, 'præcis én linje om udbyttet');
    assert.equal(u[0].old_value, '1');
    assert.equal(u[0].new_value, '1,4');
});

test('§1.2 sporet siger hvem og fra hvilken skærm', async () => {
    const k = await gemtKladde();
    k.yield.amount = 1.4;
    await post('/api/opskrifter/1/gem', k, 'opskrift-editor');
    const u = felt('recipeunitnumber')[0];
    assert.equal(u.user_id, 7, 'brugeren kommer fra sessionen');
    assert.match(u.notes || '', /opskrift-editoren/);
});

test('§1.3 brugeren tages ALDRIG fra request-body', async () => {
    // Sporet er det eneste der peger på et menneske. Kunne afsenderen skrive
    // en anden ind, var det intet værd (Patch D / #316).
    const k = await gemtKladde();
    k.yield.amount = 2;
    k.user_id = 8;
    await post('/api/opskrifter/1/gem', k, 'opskrift-editor');
    assert.equal(felt('recipeunitnumber')[0].user_id, 7);
});

test('§1.4 en ukendt kilde kasseres i stedet for at blive gemt råt', async () => {
    const k = await gemtKladde();
    k.yield.amount = 2;
    await post('/api/opskrifter/1/gem', k, 'noget-opfundet');
    const n = felt('recipeunitnumber')[0].notes;
    assert.ok(!n || !/noget-opfundet/.test(n), 'ukendt kilde må ikke stå i sporet');
});

test('§1.5 base_servings og udbyttets enhed logges også — begge flytter kostprisen', async () => {
    // yieldInStockUnits = recipeunitnumber × base_servings × faktor(recipeunit).
    // Kun at logge det første ville lade to af tre veje være usporede.
    const k = await gemtKladde();
    k.base_servings = 2;
    k.yield.unit = 'Antal';
    await post('/api/opskrifter/1/gem', k, 'opskrift-editor');
    assert.equal(felt('base_servings').length, 1);
    assert.equal(felt('base_servings')[0].new_value, '2');
    assert.equal(felt('recipeunit')[0].old_value, 'Kilo');
    assert.equal(felt('recipeunit')[0].new_value, 'Antal');
});

/* ══════════════════════════════════════════════════════════════
   §2 — Intet ændret, intet skrevet (I4 / #680)
   ══════════════════════════════════════════════════════════════ */

test('§2.1 et gem uden ændringer skriver hverken til Grocy eller i sporet', async () => {
    const k = await gemtKladde();
    const r = await post('/api/opskrifter/1/gem', k, 'opskrift-editor');
    assert.equal(r.body.wrote, false);
    assert.equal(G.skrevet.length, 0, 'intet gik til Grocy');
    assert.equal(spor().length, 0, 'og intet i sporet');
});

/* ══════════════════════════════════════════════════════════════
   §3 — Producerer vare, fremgangsmåde, navn
   ══════════════════════════════════════════════════════════════ */

test('§3.1 produceret vare logges med NAVN, ikke med et id', async () => {
    const k = await gemtKladde();
    k.yield.product_id = 60;
    await post('/api/opskrifter/1/gem', k, 'opskrift-editor');
    const p = felt('product_id')[0];
    assert.equal(p.old_value, 'Rødkål-Sylt');
    assert.equal(p.new_value, 'Hvidkål');
});

test('§3.2 en fjernet fremgangsmåde kan ses — det var #683s dyreste fund', async () => {
    const k = await gemtKladde();
    k.description = '';
    await post('/api/opskrifter/1/gem', k, 'opskrift-editor');
    const d = felt('description')[0];
    assert.equal(d.old_value, 'Skær kålen', 'den gamle tekst er bevaret, uden tags');
    assert.equal(d.new_value, null);
});

test('§3.3 en lang fremgangsmåde afkortes — changeloggen skal kunne læses', async () => {
    const stamdataLog = require('../services/stamdataLog');
    const lang = 'a'.repeat(500);
    const ud = stamdataLog.kortTekst('<p>' + lang + '</p>');
    assert.ok(ud.length <= stamdataLog.TEKST_MAX + 1, 'afkortet');
    assert.ok(ud.endsWith('…'), 'og markeret som afkortet');
});

/* ══════════════════════════════════════════════════════════════
   §4 — Linjerne: navn og mængde, ikke «1 ændret»
   ══════════════════════════════════════════════════════════════ */

test('§4.1 en ændret mængde står med varens navn', async () => {
    const k = await gemtKladde();
    k.lines.find(l => l.product_id === 20).amount = 3;
    await post('/api/opskrifter/1/gem', k, 'opskrift-editor');
    const i = felt('ingrediens');
    assert.equal(i.length, 1);
    assert.equal(i[0].old_value, 'Rødkål · 2,7');
    assert.equal(i[0].new_value, 'Rødkål · 3');
});

test('§4.2 en fjernet linje efterlader det der stod der', async () => {
    const k = await gemtKladde();
    k.lines = k.lines.filter(l => l.product_id !== 21);
    await post('/api/opskrifter/1/gem', k, 'opskrift-editor');
    const i = felt('ingrediens');
    assert.equal(i.length, 1);
    assert.equal(i[0].old_value, 'Balsamico · 0,06');
    assert.equal(i[0].new_value, null);
});

test('§4.3 en tilføjet linje logges med navn og mængde', async () => {
    const k = await gemtKladde();
    k.lines.push({ product_id: 60, amount: 0.5 });
    await post('/api/opskrifter/1/gem', k, 'opskrift-editor');
    const i = felt('ingrediens');
    assert.equal(i.length, 1);
    assert.equal(i[0].old_value, null);
    assert.equal(i[0].new_value, 'Hvidkål · 0,5');
});

test('§4.4 underopskrifter logges med opskriftens navn', async () => {
    const k = await gemtKladde();
    k.lines.find(l => l.includes_recipe_id).servings = 3;
    await post('/api/opskrifter/1/gem', k, 'opskrift-editor');
    const n = felt('underopskrift');
    assert.equal(n.length, 1);
    assert.equal(n[0].old_value, 'Lage · 2');
    assert.equal(n[0].new_value, 'Lage · 3');
});

/* ══════════════════════════════════════════════════════════════
   §5 — En ny opskrift logges som ÉN linje
   ══════════════════════════════════════════════════════════════ */

test('§5.1 oprettelse er én linje, ikke én pr. ingrediens', async () => {
    const r = await post('/api/opskrifter/ny', {
        name: 'Ny blanding', group: 'RR Produktion', base_servings: 1,
        yield: { amount: 1, unit: 'Kilo', product_id: null },
        lines: [{ product_id: 20, amount: 1 }, { product_id: 21, amount: 2 }],
    }, 'opskrift-editor');
    assert.equal(r.status, 200);
    const s = spor();
    assert.equal(s.length, 1, 'én linje — resten ER opskriften, som kan åbnes');
    assert.equal(s[0].action, 'create');
    assert.equal(s[0].new_value, 'Ny blanding');
});

/* ══════════════════════════════════════════════════════════════
   §6 — Et spor der fejler vælter ikke gemmet
   ══════════════════════════════════════════════════════════════ */

test('§6.1 changelog nede ⇒ opskriften er stadig gemt, og det siges højt', async () => {
    _db.exec('DROP TABLE changelog');
    const k = await gemtKladde();
    k.yield.amount = 1.4;
    const r = await post('/api/opskrifter/1/gem', k, 'opskrift-editor');
    assert.equal(r.status, 200, 'gemmet vælter ikke');
    assert.equal(r.body.wrote, true);
    assert.ok(r.body.log_error, 'men fejlen forsvinder ikke i stilhed');
});

test('§6.2 fejler Grocy, logges intet — en ændring der ikke skete må ikke stå', async () => {
    const k = await gemtKladde();
    k.yield.amount = 1.4;
    G.skrivFejl = 'Grocy svarer ikke';
    const r = await post('/api/opskrifter/1/gem', k, 'opskrift-editor');
    assert.equal(r.status, 400);
    assert.equal(spor().length, 0);
});

/* ══════════════════════════════════════════════════════════════
   §7 — Historikken kan ses
   ══════════════════════════════════════════════════════════════ */

test('§7.1 historikken hører til ÉN opskrift', async () => {
    const k = await gemtKladde();
    k.yield.amount = 1.4;
    await post('/api/opskrifter/1/gem', k, 'opskrift-editor');
    // En ændring på en ANDEN opskrift må ikke dukke op under den første.
    _db.prepare(`INSERT INTO changelog (entity_type, entity_id, action, field_name, new_value)
                 VALUES ('grocy_recipe', 2, 'update', 'name', 'Noget andet')`).run();

    const r = await get('/api/opskrifter/1/historik');
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);
    assert.equal(r.body[0].field_name, 'recipeunitnumber');
    assert.equal(r.body[0].user_name, 'Anne', 'brugerens navn slås op');
});

test('§7.2 et ugyldigt id afvises', async () => {
    assert.equal((await get('/api/opskrifter/aeble/historik')).status, 400);
});

/* ══════════════════════════════════════════════════════════════
   §8 — Hvem rammes: `used_by` bag advarslen
   ══════════════════════════════════════════════════════════════ */

test('§8.1 used_by tæller de opskrifter der bruger den producerede vare', async () => {
    const o = await recipeDraft.computeDraft(await gemtKladde());
    assert.equal(o.yield.used_by.count, 2, 'Grisen og Frikadellen bruger Rødkål-Sylt');
    assert.deepEqual(o.yield.used_by.names, ['Frikadellen', 'Grisen på Rug']);
});

test('§8.2 opskriften tæller ikke sig selv', async () => {
    // Producerer den en vare den også bruger, er den ikke «en anden ret».
    G.pos.push({ id: 103, recipe_id: 1, product_id: 50, amount: 0.1, qu_id: 1 });
    const o = await recipeDraft.computeDraft(await gemtKladde());
    assert.equal(o.yield.used_by.count, 2);
});

test('§8.3 producerer opskriften ingenting, er der ingen at advare om', async () => {
    const k = await gemtKladde();
    k.yield.product_id = null;
    const o = await recipeDraft.computeDraft(k);
    assert.equal(o.yield.used_by.count, 0);
    assert.deepEqual(o.yield.used_by.names, []);
});
