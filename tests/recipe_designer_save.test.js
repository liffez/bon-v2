/**
 * tests/recipe_designer_save.test.js — opskrift-designerens Gem (#680 + #364)
 * ════════════════════════════════════════════════════════════
 * Den RIGTIGE shared/recipe_designer.js køres i en vm-sandkasse med en lille
 * attrap-DOM og en falsk Grocy der registrerer hver skrivning. Datasættet er
 * et read-only udtræk fra grocy-hq (scripts/snapshot-recipes.js).
 *
 * Værnet: et Gem uden ændringer må ikke ændre noget i Grocy. Det måles to
 * veje — der sendes INGEN skrivninger, og et fingeraftryk af opskrift,
 * userfields, ingredienslinjer og nestings er byte-identisk før og efter.
 *
 * Kør også mod hele HQ:  RD_SNAPSHOT=<fil fra snapshot-recipes.js> node --test ...
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'recipe_designer', 'hq_recipes.json');
// recipe_yield.js loades FØR designeren: den låner udbytte-reglen derfra (#683),
// og grocy_num.js skal ligge før den igen (#675).
const SRC = ['shared/grocy_num.js', 'shared/moms.js', 'shared/recipe_yield.js', 'shared/recipe_designer.js']
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8'));

// De syv #680 målte + dem der rammer de andre blinde skrivninger:
// Rødløg (decimal-base i historikken), Linse Suppe (enhed 'gram'),
// Samle slider bokse (intet udbytte), Langtids stegt Gris (svind), Grisen på Rug.
const NAMED = {
    110: 'Chili Mayo', 98: 'Tahin dressing', 144: 'Yoghurt dressing', 97: 'Falaffel- stegning',
    80: 'Skære Slider Brød', 77: 'Alm slider Boks', 78: 'Vegetar slider Boks',
    14: 'Rødløg - Syltet', 81: 'Linse Suppe', 118: 'Samle slider bokse til',
    28: 'Langtids stegt Gris', 27: 'Grisen på Rug',
};

const clone = o => JSON.parse(JSON.stringify(o));

// ── attrap-DOM ────────────────────────────────────────────────
// Felternes value udledes af den HTML designeren renderer — med browserens
// regler: en <select> står på den option der er `selected`, ellers den første,
// og sættes value til noget listen ikke kender, bliver den ''. Uden det kan
// testen ikke se forskel på "Gem læser det rigtige" og "Gem læser ingenting".
const unesc = s => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (a, k) => { const m = a.match(new RegExp('\\b' + k + '="([^"]*)"')); return m ? unesc(m[1]) : null; };
let REG = null;   // id → El for den aktuelle sandkasse
function parseOptions(html) {
    const opts = [], sel = [];
    for (const m of html.matchAll(/<option\b([^>]*)>/g)) { opts.push(attr(m[1], 'value') ?? ''); if (/\bselected\b/.test(m[1])) sel.push(opts.length - 1); }
    return { opts, selected: sel.length ? sel[sel.length - 1] : (opts.length ? 0 : -1) };
}
function hydrate(html) {
    for (const m of html.matchAll(/<input\b([^>]*)>/g)) {
        const id = attr(m[1], 'id'); if (!id) continue;
        const el = REG.get(id); el._value = attr(m[1], 'value') ?? '';
    }
    for (const m of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
        // Browseren normaliserer linjeskift i en textarea til \n.
        const id = attr(m[1], 'id'); if (id) REG.get(id)._value = unesc(m[2]).replace(/\r\n?/g, '\n');
    }
    for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
        const id = attr(m[1], 'id'); if (!id) continue;
        const el = REG.get(id); el._isSelect = true; el._setOptions(m[2]);
    }
}
class El {
    constructor(id) {
        this.id = id || ''; this._value = ''; this._html = ''; this.textContent = '';
        this._isSelect = false; this._opts = [];
        this.style = {}; this.checked = false; this.disabled = false; this.dataset = {};
        this._cls = new Set(); this._listeners = {}; this._attrs = {};
        const self = this;
        this.classList = {
            add: (...c) => c.forEach(x => self._cls.add(x)),
            remove: (...c) => c.forEach(x => self._cls.delete(x)),
            toggle: (c, f) => { const on = f === undefined ? !self._cls.has(c) : f; on ? self._cls.add(c) : self._cls.delete(c); return on; },
            contains: c => self._cls.has(c),
        };
    }
    get value() { return this._value; }
    set value(v) {
        v = v == null ? '' : String(v);
        if (this._isSelect) v = this._opts.includes(v) ? v : '';
        this._value = v;
    }
    _setOptions(html) {
        const { opts, selected } = parseOptions(html);
        this._opts = opts; this._value = selected >= 0 ? opts[selected] : '';
    }
    get innerHTML() { return this._html; }
    set innerHTML(h) {
        this._html = String(h);
        if (this._isSelect || /^\s*<option\b/.test(this._html)) { this._isSelect = true; this._setOptions(this._html); }
        else if (REG) hydrate(this._html);
    }
    addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); }
    removeEventListener() {}
    fire(t, extra) { (this._listeners[t] || []).forEach(f => f.call(this, Object.assign({ target: this, preventDefault() {}, stopPropagation() {} }, extra))); }
    querySelector() { return new El(); }
    querySelectorAll() { return []; }
    closest() { return null; }
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
    setAttribute(k, v) { this._attrs[k] = String(v); }
    removeAttribute(k) { delete this._attrs[k]; }
    appendChild(c) { return c; }
    insertAdjacentHTML() {}
    remove() {}
    focus() {} blur() {} select() {} scrollIntoView() {}
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
}

// ── falsk Grocy ───────────────────────────────────────────────
function fakeGrocy(snap) {
    const st = clone(snap);
    const writes = [];
    const byId = (arr, id) => arr.find(x => x.id == id);
    let nextId = 900000;
    const api = {
        fetchGrocyRecipesRaw: async () => clone(st.recipes),
        fetchGrocyProducts: async () => clone(st.products),
        fetchGrocyQuantityUnits: async () => clone(st.quantity_units),
        fetchGrocyStock: async () => [],
        fetchGrocyRecipesPos: async () => clone(st.recipes_pos),
        fetchGrocyRecipesNestings: async () => clone(st.recipes_nestings),
        fetchGrocyQuantityUnitConversions: async () => clone(st.quantity_unit_conversions),
        fetchGrocyUserfields: async () => clone(st.userfields),
        // Editoren skal kunne sætte en varegruppe på en ny vare. Findes
        // funktionen ikke i sandkassen, kaster `_rdLoadData` SYNKRONT — før
        // dens egen .catch kan gribe — og hele designeren nægter at loade.
        fetchGrocyProductGroups: async () => [],
        fetchLaborRate: async () => ({ rate: null, overhead_pct: 0, count: 0 }),
        fetchRecipeTargets: async () => ({}),
        fetchRecipeComposition: async () => null,
        postGrocyShoppingList: async () => ({}),

        putGrocyRecipe: async (id, body) => { writes.push(['putRecipe', id, clone(body)]); Object.assign(byId(st.recipes, id), body); return { ok: true }; },
        putGrocyRecipeUserfields: async (id, f) => { writes.push(['putUserfields', id, clone(f)]); const r = byId(st.recipes, id); r.userfields = Object.assign(r.userfields || {}, f); return { ok: true }; },
        postGrocyRecipe: async (body) => { writes.push(['postRecipe', clone(body)]); const id = ++nextId; st.recipes.push(Object.assign({ id, userfields: {} }, body)); return { created_object_id: id }; },
        putGrocyRecipePos: async (id, body) => { writes.push(['putPos', id, clone(body)]); Object.assign(byId(st.recipes_pos, id), body); return { ok: true }; },
        postGrocyRecipePos: async (body) => { writes.push(['postPos', clone(body)]); st.recipes_pos.push(Object.assign({ id: ++nextId }, body)); return { created_object_id: nextId }; },
        deleteGrocyRecipePos: async (id) => { writes.push(['delPos', id]); st.recipes_pos = st.recipes_pos.filter(p => p.id != id); return { ok: true }; },
        putGrocyRecipeNesting: async (id, body) => { writes.push(['putNest', id, clone(body)]); Object.assign(byId(st.recipes_nestings, id), body); return { ok: true }; },
        postGrocyRecipeNesting: async (body) => { writes.push(['postNest', clone(body)]); st.recipes_nestings.push(Object.assign({ id: ++nextId }, body)); return { created_object_id: nextId }; },
        deleteGrocyRecipeNesting: async (id) => { writes.push(['delNest', id]); st.recipes_nestings = st.recipes_nestings.filter(n => n.id != id); return { ok: true }; },
    };
    return { st, writes, api };
}

// Alt Grocy ved om én opskrift. Tidsstempler udelades — de siger intet om indholdet.
function fingerprint(st, id) {
    const strip = o => { const c = clone(o); delete c.row_created_timestamp; return c; };
    const r = st.recipes.find(x => x.id == id);
    return JSON.stringify({
        recipe: r ? strip(r) : null,
        pos: st.recipes_pos.filter(p => p.recipe_id == id).map(strip).sort((a, b) => a.id - b.id),
        nest: st.recipes_nestings.filter(n => n.recipe_id == id).map(strip).sort((a, b) => a.id - b.id),
    });
}

async function boot(snap) {
    const g = fakeGrocy(snap);
    const els = {};
    REG = { get: id => (els[id] = els[id] || new El(id)) };
    const document = {
        getElementById: id => REG.get(id),
        createElement: () => new El(),
        querySelector: () => new El(),
        querySelectorAll: () => [],
        addEventListener() {}, body: new El('body'),
    };
    const ctx = Object.assign({
        document, console,
        setTimeout: () => 0, clearTimeout() {},
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        confirm: () => true, alert() {},
        esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    }, g.api);
    ctx.window = ctx; ctx.self = ctx;
    vm.createContext(ctx);
    SRC.forEach(code => vm.runInContext(code, ctx));
    const run = expr => vm.runInContext(expr, ctx);
    const container = new El('container');
    ctx.__c = container;
    return { g, ctx, run, els, container };
}

// initRecipeDesigner + vent på indlæsningen.
async function openDesigner(snap, recipeId) {
    const h = await boot(snap);
    h.run('_rdContainer = __c');
    await h.run('_rdLoadData()');
    assert.equal(h.run('_rdDataLoaded'), true, 'designeren kunne ikke indlæse data');
    if (recipeId != null) h.run('_rdOpenForEdit(' + recipeId + ')');
    return h;
}

const SNAP = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

// ── §1 Værnet: Gem uden ændringer ─────────────────────────────
for (const [id, name] of Object.entries(NAMED)) {
    test(`§1 uændret Gem ændrer intet: #${id} ${name}`, async () => {
        const h = await openDesigner(SNAP, id);
        const before = fingerprint(h.g.st, id);
        await h.run('_rdSaveRecipe()');
        assert.deepEqual(h.g.writes, [], `#${id} ${name}: et uændret Gem sendte skrivninger`);
        assert.equal(fingerprint(h.g.st, id), before, `#${id} ${name}: fingeraftrykket flyttede sig`);
    });
}

if (process.env.RD_SNAPSHOT) {
    test('§1b uændret Gem ændrer intet — ALLE opskrifter i snapshottet', async () => {
        const all = JSON.parse(fs.readFileSync(process.env.RD_SNAPSHOT, 'utf8'));
        const bad = [];
        for (const r of all.recipes) {
            const h = await openDesigner(all, r.id);
            const before = fingerprint(h.g.st, r.id);
            await h.run('_rdSaveRecipe()');
            if (h.g.writes.length || fingerprint(h.g.st, r.id) !== before) {
                bad.push(`#${r.id} ${r.name}: ${JSON.stringify(h.g.writes)}`);
            }
        }
        assert.deepEqual(bad, [], `${bad.length} af ${all.recipes.length} opskrifter ændres ved et uændret Gem`);
    });
}

// ── §2 Udbyttet er sit eget felt ──────────────────────────────
test('§2 feltet viser udbyttet fra Grocy — ikke base_servings', async () => {
    const h = await openDesigner(SNAP, 80);    // Slider Brød: base 64, udbytte 1
    assert.equal(h.run('_rdDs.yieldNum'), 1);
    assert.equal(h.run('_rdDs.baseServings'), 64);
    const h2 = await openDesigner(SNAP, 110);  // Chili Mayo: 1,1 kg
    assert.equal(h2.run('_rdDs.yieldNum'), 1.1);
    assert.equal(h2.run('_rdFmtNum(_rdDs.yieldNum)'), '1,1', 'udbyttet vises med dansk komma');
});

test('§2 ret udbyttet → kun recipeunitnumber skrives', async () => {
    const h = await openDesigner(SNAP, 110);
    const el = h.els.rdDYield;
    el.value = '1,25';                       // dansk komma
    el.fire('change');
    const before = JSON.parse(fingerprint(h.g.st, 110));
    await h.run('_rdSaveRecipe()');
    assert.deepEqual(h.g.writes, [['putUserfields', 110, { recipeunitnumber: '1.25' }]]);
    const after = JSON.parse(fingerprint(h.g.st, 110));
    assert.equal(after.recipe.userfields.recipeunitnumber, '1.25');
    after.recipe.userfields.recipeunitnumber = before.recipe.userfields.recipeunitnumber;
    assert.deepEqual(after, before, 'andet end udbyttet flyttede sig');
});

test('§2 ændret antal portioner rører IKKE udbyttet (#680)', async () => {
    const h = await openDesigner(SNAP, 97);  // Falaffel-stegning: udbytte 36
    const el = h.els.rdDBaseServings;
    el.value = '2,5';                        // decimal — parseInt gjorde det til 2
    el.fire('change');
    await h.run('_rdSaveRecipe()');
    assert.deepEqual(h.g.writes, [['putRecipe', 97, { base_servings: 2.5 }]]);
    assert.equal(h.g.st.recipes.find(r => r.id == 97).userfields.recipeunitnumber, '36');
});

test('§2 tømt udbytte skrives som tomt — og kun det', async () => {
    const h = await openDesigner(SNAP, 110);
    h.els.rdDYield.value = '';
    h.els.rdDYield.fire('change');
    await h.run('_rdSaveRecipe()');
    assert.deepEqual(h.g.writes, [['putUserfields', 110, { recipeunitnumber: '' }]]);
});

test('§2 vrøvl i udbyttet rulles tilbage og gemmer intet', async () => {
    const h = await openDesigner(SNAP, 110);
    h.els.rdDYield.value = 'abc';
    h.els.rdDYield.fire('change');
    assert.equal(h.els.rdDYield.value, '1,1');
    await h.run('_rdSaveRecipe()');
    assert.deepEqual(h.g.writes, []);
});

test('§2 opskrift uden udbytte får ikke opfundet et (#118)', async () => {
    const h = await openDesigner(SNAP, 118);
    assert.equal(h.run('_rdDs.yieldNum'), null);
    assert.equal(h.els.rdDYield.value, '', 'feltet står tomt');
    await h.run('_rdSaveRecipe()');
    assert.deepEqual(h.g.writes, []);
});

// ── §3 Enhed og gruppe: listen kommer fra Grocy, og den aktuelle værdi forsvinder aldrig ──
test('§3 enhedslisten er Grocys — ingen fast stk/portion', async () => {
    const h = await openDesigner(SNAP, 110);
    const html = h.run("_rdOptionsHtml('recipeunit', 'kg', '— vælg —')");
    const opts = [...html.matchAll(/value="([^"]*)"/g)].map(m => m[1]);
    for (const u of ['kg', 'gram', 'liter', 'deciliter', 'antal', 'Timer', 'Kr']) assert.ok(opts.includes(u), u + ' mangler');
    assert.ok(!opts.includes('stk'), 'stk står der uden at Grocy kender den');
    assert.ok(!opts.includes('portion'), 'portion står der uden at Grocy kender den');
    assert.match(html, /value="kg" selected/);
});

for (const [unit, label] of [['stk', 'en enhed Grocy ikke længere kender'], ['liter,antal', 'en flervalgs-værdi'], ['', 'ingen enhed']]) {
    test(`§3 uændret Gem bevarer ${label} (${JSON.stringify(unit)})`, async () => {
        const snap = clone(SNAP);
        snap.recipes.find(r => r.id == 110).userfields.recipeunit = unit === '' ? null : unit;
        const h = await openDesigner(snap, 110);
        const html = h.run("_rdOptionsHtml('recipeunit', _rdDs.recipeUnit, '— vælg —')");
        assert.match(html, new RegExp('value="' + unit.replace(/[,]/g, '\\$&') + '" selected'), 'den aktuelle værdi er valgt');
        await h.run('_rdSaveRecipe()');
        assert.deepEqual(h.g.writes, []);
    });
}

test('§3 opskrift uden gruppe får ikke skrevet "Ingen kategori"', async () => {
    const snap = clone(SNAP);
    snap.recipes.find(r => r.id == 110).userfields.grupper = null;
    const h = await openDesigner(snap, 110);
    assert.match(h.els.rdDGroup.innerHTML, /<option value="" selected>Ingen kategori<\/option>/);
    await h.run('_rdSaveRecipe()');
    assert.deepEqual(h.g.writes, []);
});

test('§3 beskrivelse med Windows-linjeskift skrives ikke tilbage', async () => {
    const snap = clone(SNAP);
    snap.recipes.find(r => r.id == 110).description = 'Bland\r\nSmag til';
    const h = await openDesigner(snap, 110);
    assert.equal(h.els.rdDNotes.value, 'Bland\nSmag til');
    h.els.rdDNotes.fire('input');           // brugeren har været i feltet uden at ændre noget
    await h.run('_rdSaveRecipe()');
    assert.deepEqual(h.g.writes, []);
});

test('§3 navn med mellemrum i enden skrives ikke tilbage', async () => {
    const snap = clone(SNAP);
    snap.recipes.find(r => r.id == 110).name = 'Chili Mayo ';
    const h = await openDesigner(snap, 110);
    await h.run('_rdSaveRecipe()');
    assert.deepEqual(h.g.writes, []);
});

test('§3 skift af enhed skriver kun enheden', async () => {
    const h = await openDesigner(SNAP, 110);
    h.els.rdDUnit.value = 'liter';
    h.els.rdDUnit.fire('change');
    await h.run('_rdSaveRecipe()');
    assert.deepEqual(h.g.writes, [['putUserfields', 110, { recipeunit: 'liter' }]]);
});

// ── §4 Gem som ny ─────────────────────────────────────────────
test('§4 kopi tager kildens udbytte, enhed og portioner med', async () => {
    const h = await openDesigner(SNAP, 110);
    h.els.rdDName.value = 'Chili Mayo kopi';
    h.els.rdDName.fire('input');
    await h.run('_rdSaveAsNew()');
    const post = h.g.writes.find(w => w[0] === 'postRecipe');
    assert.equal(post[1].base_servings, 1);
    const uf = h.g.writes.find(w => w[0] === 'putUserfields');
    assert.equal(uf[2].recipeunitnumber, '1.1');
    assert.equal(uf[2].recipeunit, 'kg');
    assert.equal(uf[2].grupper, 'RR produktion Hurtig');
});

test('§4 ny opskrift uden udbytte får ikke opfundet et', async () => {
    const h = await openDesigner(SNAP, null);
    h.run('_rdStartNew()');
    h.els.rdDName.value = 'Helt ny';
    h.els.rdDName.fire('input');
    await h.run('_rdSaveAsNew()');
    const uf = h.g.writes.find(w => w[0] === 'putUserfields');
    assert.ok(!uf || !('recipeunitnumber' in uf[2]), 'et udbytte blev skrevet på en ny opskrift uden et');
    assert.ok(!uf || !('recipeunit' in uf[2]), 'en enhed blev skrevet på en ny opskrift uden en');
});

test('§4 et Gem efter Gem som ny sammenligner med det nye', async () => {
    const h = await openDesigner(SNAP, 110);
    h.els.rdDName.value = 'Chili Mayo kopi';
    h.els.rdDName.fire('input');
    await h.run('_rdSaveAsNew()');
    h.g.writes.length = 0;
    await h.run('_rdSaveRecipe()');
    assert.deepEqual(h.g.writes, []);
});

// ── §5 Linjer: kun det der er ændret ──────────────────────────
test('§5 én ændret ingrediens → én PUT med kun mængden', async () => {
    const h = await openDesigner(SNAP, 110);
    const pid = h.run('_rdDs.ingredients[1].id');
    h.run('_rdDs.ingredients[1].amount = 0.2');
    await h.run('_rdSaveRecipe()');
    assert.deepEqual(h.g.writes, [['putPos', pid, { amount: 0.2 }]]);
});

// ── §6 #364: underopskrift-mængder vises i én enhed og gemmes i en anden ──
test('§6 _rdDisplayToOrigUnit går alle fire veje tilbage', async () => {
    const h = await openDesigner(SNAP, null);
    const f = (v, d, o) => h.run(`_rdDisplayToOrigUnit(${v}, ${JSON.stringify(d)}, ${JSON.stringify(o)})`);
    assert.equal(f(500, 'g', 'kg'), 0.5);
    assert.equal(f(250, 'ml', 'liter'), 0.25);
    assert.equal(f(2, 'kg', 'gram'), 2000);
    assert.equal(f(2, 'kg', 'g'), 2000);
    assert.equal(f(1.5, 'l', 'ml'), 1500);
    assert.equal(f(3, 'antal', 'antal'), 3);
});

for (const [unit, shown, typed, want] of [['gram', 'kg', '2', 2000], ['ml', 'l', '2', 2000], ['kg', 'g', '500', 0.5]]) {
    test(`§6 nesting i ${unit}: tastet ${typed} ${shown} gemmes som ${want}`, async () => {
        const snap = clone(SNAP);
        const n = snap.recipes_nestings[0];
        snap.recipes.find(r => r.id == n.includes_recipe_id).userfields.recipeunit = unit;
        const h = await openDesigner(snap, n.recipe_id);
        const idx = h.run(`_rdDs.nestings.findIndex(x => x.id == ${n.id})`);
        const input = new El();
        input._attrs = { 'data-idx': String(idx), 'data-display-unit': shown, 'data-orig-unit': unit };
        input.value = typed;
        input.closest = sel => (sel === '.rd-nesting-input' ? input : null);
        h.els.rdNestingCards.onchange({ target: input });   // samme vej som et rigtigt felt
        await h.run('_rdSaveRecipe()');
        assert.deepEqual(h.g.writes, [['putNest', n.id, { servings: want }]]);
    });
}

// ── §7 Produceret vare (#683) ─────────────────────────────────
//
// `recipes.product_id` er ikke et felt som de andre: det flytter
// produktionstype, lagertræk og kostpris i samme øjeblik. Testene her måler
// tre ting — at feltet LÆSES fra Grocy, at Gem sender det ALENE, og at et
// nej til bekræftelsen ikke skriver noget.

// Snapshot med en ændring — fixturen selv røres aldrig.
function withSnap(fn) { const s = clone(SNAP); fn(s); return s; }

test('§7 feltet læses fra Grocy', async () => {
    const h = await openDesigner(SNAP, 110);          // Chili Mayo → vare 34
    assert.equal(h.run('_rdDs.productId'), 34);
    const h2 = await openDesigner(SNAP, 77);          // slider-boks → ingen vare
    assert.equal(h2.run('_rdDs.productId'), null);
});

test('§7 ret varen → kun product_id skrives', async () => {
    const h = await openDesigner(SNAP, 110);
    h.run('_rdDs.productId = 33');
    await h.run('_rdSaveRecipe()');
    assert.deepEqual(h.g.writes, [['putRecipe', 110, { product_id: 33 }]]);
});

test('§7 fjern varen → product_id sættes til null', async () => {
    const h = await openDesigner(SNAP, 110);
    h.run('_rdDs.productId = null');
    await h.run('_rdSaveRecipe()');
    assert.deepEqual(h.g.writes, [['putRecipe', 110, { product_id: null }]]);
});

test('§7 en opskrift uden vare får ikke sat en', async () => {
    const h = await openDesigner(SNAP, 77);
    h.run('_rdDs.name = _rdDs.name + " "');   // en anden, harmløs ændring
    h.run('_rdDs.name = _rdDs.name.trim()');  // ... som trimmes væk igen
    await h.run('_rdSaveRecipe()');
    assert.deepEqual(h.g.writes, [], 'der blev skrevet noget på en uændret opskrift uden vare');
});

test('§7 nej til bekræftelsen gemmer intet', async () => {
    const h = await openDesigner(SNAP, 110);
    const before = fingerprint(h.g.st, 110);
    h.ctx.confirm = () => false;
    h.run('_rdDs.productId = 33');
    await h.run('_rdSaveRecipe()');
    assert.deepEqual(h.g.writes, [], 'et nej til bekræftelsen skrev alligevel til Grocy');
    assert.equal(fingerprint(h.g.st, 110), before);
});

test('§7 bekræftelsen nævner varen og hvad der ændrer sig', async () => {
    const h = await openDesigner(SNAP, 110);
    const seen = [];
    h.ctx.confirm = (m) => { seen.push(m); return true; };
    h.run('_rdDs.productId = 33');
    await h.run('_rdSaveRecipe()');
    assert.equal(seen.length, 1, 'der blev ikke spurgt før gem');
    assert.match(seen[0], /Rødløg - Sylt/, 'varens navn står ikke i bekræftelsen');
    assert.match(seen[0], /LEVERET|lager/i, 'konsekvensen for produktionen står ikke i bekræftelsen');
    assert.match(seen[0], /[Kk]ostpris/, 'konsekvensen for kostprisen står ikke i bekræftelsen');
});

test('§7 en ændring UDEN produceret vare spørger ikke', async () => {
    const h = await openDesigner(SNAP, 110);
    let asked = 0;
    h.ctx.confirm = () => { asked++; return true; };
    h.run('_rdDs.name = "Chili Mayo 2"');
    await h.run('_rdSaveRecipe()');
    assert.equal(asked, 0, 'der blev spurgt om produceret vare ved en ren navneændring');
    assert.deepEqual(h.g.writes, [['putRecipe', 110, { name: 'Chili Mayo 2' }]]);
});

test('§7 Gem som ny arver ikke den producerede vare', async () => {
    const h = await openDesigner(SNAP, 110);
    h.run('_rdDs.name = "Chili Mayo — kopi"');
    await h.run('_rdSaveAsNew()');
    const post = h.g.writes.find(w => w[0] === 'postRecipe');
    assert.ok(post, 'ingen ny opskrift blev oprettet');
    assert.equal(post[1].product_id, null, 'kopien arvede den producerede vare');
    assert.equal(h.run('_rdDs.productId'), null, 'designeren tror stadig kopien producerer varen');
});

// ── §8 Konsekvensen, som ren funktion ─────────────────────────

const impact = (h, inp) => { h.ctx.__im = inp; return h.run('_rdComputeProducesImpact(__im)'); };

// Alt det state `_rdProducesImpact` ellers læser, samlet ét sted.
function impactBase(over) {
    return Object.assign({
        recipeId: 110, recipeName: 'Chili Mayo', productId: 34,
        product: SNAP.products.find(p => p.id === 34),
        group: 'RR produktion Hurtig',
        yieldNum: 1.1, recipeUnit: 'kg', baseServings: 1,
        recipes: SNAP.recipes, nestings: SNAP.recipes_nestings,
        units: SNAP.quantity_units, conversions: SNAP.quantity_unit_conversions,
    }, over || {});
}

test('§8 gruppen afgør on_demand/to_stock', async () => {
    const h = await openDesigner(SNAP, 110);
    assert.equal(impact(h, impactBase()).type, 'on_demand');
    assert.equal(impact(h, impactBase({ group: 'RR Produktion' })).type, 'to_stock');
    assert.equal(impact(h, impactBase({ group: '01 Sandwich' })).type, 'to_stock');
    assert.equal(impact(h, impactBase({ productId: null })).type, null, 'ingen vare → ingen produktionstype');
});

test('§8 designerens Hurtig-gruppe er DRIFTENS', async () => {
    // Reglen står to steder, fordi browserkode ikke kan require'e
    // services/ingredientResolver.js. Driver de fra hinanden, viser designeren
    // én produktionstype mens lagertrækket bruger en anden.
    const h = await openDesigner(SNAP, 110);
    const { HURTIG_GROUP } = require('../services/ingredientResolver');
    assert.equal(h.run('RD_HURTIG_GROUP'), HURTIG_GROUP);
});

test('§8 opskrifter der nester denne nævnes — de skifter lagertræk', async () => {
    const h = await openDesigner(SNAP, 110);
    const nest = SNAP.recipes_nestings.concat([{ id: 5001, recipe_id: 77, includes_recipe_id: 110, servings: 2 }]);
    const im = impact(h, impactBase({ nestings: nest }));
    assert.equal(im.nestedIn.length, 1);
    assert.equal(im.nestedIn[0].id, 77);
    assert.equal(impact(h, impactBase()).nestedIn.length, 0, 'ingen nester Chili Mayo i fixturen');
});

test('§8 flere producenter → kostprisen regnes efter laveste opskrift-id', async () => {
    const h = await openDesigner(SNAP, 110);
    const rs = clone(SNAP.recipes);
    rs.find(r => r.id === 97).product_id = 34;          // #97 < #110
    const im = impact(h, impactBase({ recipes: rs }));
    assert.equal(im.otherProducers.length, 1);
    assert.equal(im.isWinner, false, '#110 kan ikke vinde over #97');
    assert.equal(im.winner.id, 97);

    const rs2 = clone(SNAP.recipes);
    rs2.find(r => r.id === 144).product_id = 34;        // #144 > #110
    const im2 = impact(h, impactBase({ recipes: rs2 }));
    assert.equal(im2.isWinner, true, '#110 er laveste id og skal vinde');
});

test('§8 en ny opskrift kan ikke være den der vinder', async () => {
    const h = await openDesigner(SNAP, 110);
    // recipeId null = opskriften er ikke gemt endnu og har intet id. Et nyt id
    // er altid højere end de eksisterende, så den kan per definition ikke vinde.
    const im = impact(h, impactBase({ recipeId: null, recipeName: 'Ny mayo' }));
    assert.equal(im.otherProducers.length, 1, 'den eksisterende producent skal nævnes');
    assert.equal(im.otherProducers[0].id, 110);
    assert.equal(im.isWinner, false);
});

test('§8 udbyttet regnes med RecipeYield — også antal → kilo', async () => {
    const h = await openDesigner(SNAP, 80);
    // Chili Mayo: 1 portion = 1,1 kg, base 1
    assert.equal(impact(h, impactBase()).yieldStock, 1.1);
    // Slider Brød: 64 portioner à 1 antal, og 1 antal = 0,06 kg på varen.
    const im = impact(h, impactBase({
        recipeId: 80, productId: 231, product: SNAP.products.find(p => p.id === 231),
        yieldNum: 1, recipeUnit: 'antal', baseServings: 64,
    }));
    assert.ok(Math.abs(im.yieldStock - 3.84) < 1e-9, 'fik ' + im.yieldStock + ', ventede 3,84 kg');
});

test('§8 et udbytte der ikke kan bestemmes siges højt', async () => {
    const h = await openDesigner(SNAP, 110);
    assert.equal(impact(h, impactBase({ yieldNum: null })).yieldStock, null);
    assert.equal(impact(h, impactBase({ recipeUnit: 'Timer' })).yieldStock, null,
        'en enhed Grocy ikke kender må ikke give et plausibelt tal');
    h.run('_rdDs.yieldNum = null');
    const info = h.run('_rdProducesInfo(_rdProducesImpact(34))');
    assert.ok(info.warnings.some(l => /[Uu]dbytt/.test(l)),
        'manglende udbytte står ikke som advarsel: ' + JSON.stringify(info.warnings));
    assert.ok(!info.details.some(l => /[Uu]dbytt/.test(l)),
        'en manglende værdi må ikke gemmes bag folden');
});

test('§8 en inaktiv vare markeres', async () => {
    const h = await openDesigner(SNAP, 110);
    const p = clone(SNAP.products.find(x => x.id === 34));
    p.active = '0';
    assert.equal(impact(h, impactBase({ product: p })).productInactive, true);
    assert.equal(impact(h, impactBase()).productInactive, false);
});

// ── §9 Underopskrift som vare-linje (#270) ────────────────────
//
// Reglen er "har underopskriften en vare, så brug varen" — ikke "nestings er
// forbudt". Slider-boksene 77/78 er bevidst indlejrede, og deres børn
// producerer ingen vare.

test('§9 en opskrift der producerer en vare lægges ind som ingrediens', async () => {
    const h = await openDesigner(SNAP, 77);
    const nestFør = h.run('_rdDs.nestings.length');
    const ingFør  = h.run('_rdDs.ingredients.length');
    h.run('_rdToggleAddNestingPanel()');                     // som brugeren gør
    h.run('_rdSelectNestRecipe(110)');                       // Chili Mayo → vare 34
    h.els.rdNestAmt.value = '0.025';                         // tastet i varens lager-enhed (kg)
    h.run('_rdConfirmAddNesting()');
    assert.equal(h.run('_rdDs.nestings.length'), nestFør, 'der blev lavet en nesting alligevel');
    assert.equal(h.run('_rdDs.ingredients.length'), ingFør + 1);
    const ny = h.run('_rdDs.ingredients[_rdDs.ingredients.length - 1]');
    assert.equal(ny.product_id, 34);
    assert.equal(ny.qu_id, 4, 'linjen skal stå i varens lager-enhed (Kilo)');
    assert.ok(Math.abs(ny.amount - 0.025) < 1e-9);
});

test('§9 en opskrift uden vare lægges fortsat ind som underopskrift', async () => {
    const h = await openDesigner(SNAP, 77);
    const nestFør = h.run('_rdDs.nestings.length');
    const ingFør  = h.run('_rdDs.ingredients.length');
    h.run('_rdToggleAddNestingPanel()');
    h.run('_rdSelectNestRecipe(118)');                       // Samle slider bokse — ingen vare
    h.els.rdNestAmt.value = '2';
    h.run('_rdConfirmAddNesting()');
    assert.equal(h.run('_rdDs.nestings.length'), nestFør + 1, 'nestings skal stadig kunne bruges');
    assert.equal(h.run('_rdDs.ingredients.length'), ingFør);
    assert.equal(h.run('_rdDs.nestings[_rdDs.nestings.length - 1].servings'), 2);
});

test('§9 mængden skaleres som en ingrediens, ikke som en portion', async () => {
    const h = await openDesigner(SNAP, 77);
    h.run('_rdDs.currentPortions = _rdDs.baseServings * 4');
    h.run('_rdToggleAddNestingPanel()');
    h.run('_rdSelectNestRecipe(110)');
    h.els.rdNestAmt.value = '0.4';                           // 0,4 kg på den SKALEREDE mængde
    h.run('_rdConfirmAddNesting()');
    const ny = h.run('_rdDs.ingredients[_rdDs.ingredients.length - 1]');
    assert.ok(Math.abs(ny.amount - 0.1) < 1e-9, 'basismængden skal være 0,1 kg, fik ' + ny.amount);
});

test('§9 omdan eksisterende nesting → ingrediens, og nestingen slettes', async () => {
    const snap = withSnap(s => {
        s.recipes_nestings.push({ id: 5001, recipe_id: 77, includes_recipe_id: 110, servings: 2 });
    });
    const h = await openDesigner(snap, 77);
    const ingFør = h.run('_rdDs.ingredients.length');
    const idx = h.run('_rdDs.nestings.findIndex(function(n){ return n.includes_recipe_id == 110; })');
    assert.ok(idx >= 0, 'nestingen blev ikke indlæst');
    h.run('_rdConvertNestingToLine(' + idx + ')');

    assert.equal(h.run('_rdDs.nestings.some(function(n){ return n.includes_recipe_id == 110; })'), false);
    assert.equal(h.run('JSON.stringify(_rdDs.removedNestIds)'), '[5001]', 'nestingen slettes ikke ved Gem');
    assert.equal(h.run('_rdDs.ingredients.length'), ingFør + 1);
    const ny = h.run('_rdDs.ingredients[_rdDs.ingredients.length - 1]');
    assert.equal(ny.product_id, 34);
    // Udbyttet er broen: 2 portioner Chili Mayo à 1,1 kg = 2,2 kg.
    assert.ok(Math.abs(ny.amount - 2.2) < 1e-9, 'fik ' + ny.amount + ', ventede 2,2 kg');
});

test('§9 omdan afvises når udbyttet ikke kan bestemmes', async () => {
    const snap = withSnap(s => {
        s.recipes_nestings.push({ id: 5002, recipe_id: 77, includes_recipe_id: 110, servings: 2 });
        s.recipes.find(r => r.id === 110).userfields.recipeunitnumber = '';
    });
    const h = await openDesigner(snap, 77);
    const ingFør = h.run('_rdDs.ingredients.length');
    const idx = h.run('_rdDs.nestings.findIndex(function(n){ return n.includes_recipe_id == 110; })');
    h.run('_rdConvertNestingToLine(' + idx + ')');
    assert.equal(h.run('_rdDs.ingredients.length'), ingFør, 'der blev gættet en mængde');
    assert.equal(h.run('_rdDs.nestings.some(function(n){ return n.includes_recipe_id == 110; })'), true,
        'nestingen blev fjernet uden at noget kom i stedet');
});

test('§9 nej til bekræftelsen omdanner ikke', async () => {
    const snap = withSnap(s => {
        s.recipes_nestings.push({ id: 5003, recipe_id: 77, includes_recipe_id: 110, servings: 2 });
    });
    const h = await openDesigner(snap, 77);
    h.ctx.confirm = () => false;
    const ingFør = h.run('_rdDs.ingredients.length');
    const idx = h.run('_rdDs.nestings.findIndex(function(n){ return n.includes_recipe_id == 110; })');
    h.run('_rdConvertNestingToLine(' + idx + ')');
    assert.equal(h.run('_rdDs.ingredients.length'), ingFør);
    assert.equal(h.run('_rdDs.nestings.some(function(n){ return n.includes_recipe_id == 110; })'), true);
});

// ── §10 Valget skal kunne ses, ikke kun være rigtigt ──────────

test('§10 en inaktiv vare kan ikke vælges som produceret vare', async () => {
    // «kål» blev sat inaktiv i en optælling og gav 13 bons `partial` (#645).
    const snap = withSnap(s => { s.products.find(p => p.id === 34).active = '0'; });
    const h = await openDesigner(snap, 77);              // opskrift uden vare → vælgeren vises
    h.run('_rdOnProdAcInput("mayo")');
    const html = h.els.rdProdAcDropdown.innerHTML;
    assert.ok(!/data-pid="34"/.test(html), 'den inaktive vare kunne vælges: ' + html);

    const h2 = await openDesigner(SNAP, 77);             // samme søgning, aktiv vare
    h2.run('_rdOnProdAcInput("mayo")');
    assert.match(h2.els.rdProdAcDropdown.innerHTML, /data-pid="34"/,
        'den aktive vare mangler i listen — så måler testen ovenfor ingenting');
});

test('§10 vælgeren siger at varen allerede laves af en anden opskrift', async () => {
    const h = await openDesigner(SNAP, 77);
    h.run('_rdOnProdAcInput("mayo")');
    assert.match(h.els.rdProdAcDropdown.innerHTML, /laves allerede af/,
        'listen nævner ikke at Chili Mayo allerede produceres af en opskrift');
});

test('§10 underopskrift-listen viser HVAD der sker før man vælger', async () => {
    const h = await openDesigner(SNAP, 77);
    h.run('_rdToggleAddNestingPanel()');
    h.run('_rdOnNestAcInput("mayo")');                   // Chili Mayo — producerer vare 34
    assert.match(h.els.rdNestAcDropdown.innerHTML, /rd-nest-badge-vare/,
        'en opskrift der ER en vare er ikke mærket i listen');

    h.run('_rdOnNestAcInput("samle")');                  // Samle slider bokse — ingen vare
    const html = h.els.rdNestAcDropdown.innerHTML;
    assert.ok(/rd-nest-badge/.test(html) && !/rd-nest-badge-vare/.test(html),
        'en almindelig underopskrift er mærket som vare: ' + html);
});

test('§10 valget forklarer sig i panelet', async () => {
    const h = await openDesigner(SNAP, 77);
    h.run('_rdToggleAddNestingPanel()');
    h.run('_rdSelectNestRecipe(110)');
    const hint = h.els.rdNestHint.innerHTML;
    assert.match(hint, /Chili Mayo/, 'varens navn står ikke i forklaringen');
    assert.match(hint, /ingrediens/i, 'det står ikke at den lægges ind som ingrediens');
    assert.equal(h.els.rdNestUnitLabel.textContent, 'Kilo', 'mængden skal tastes i varens lager-enhed');

    h.run('_rdSelectNestRecipe(118)');                   // uden vare
    assert.match(h.els.rdNestHint.innerHTML, /underopskrift/i);
    assert.notEqual(h.els.rdNestUnitLabel.textContent, 'Kilo');
});

test('§10 panelet siger det korte fremme og gemmer resten bag folden', async () => {
    // Panelet ses af enhver der åbner opskriften — også en i køkkenet, der bare
    // skal se hvad der er i den. Én linje fremme; forklaringen foldes.
    const h = await openDesigner(SNAP, 110);             // Chili Mayo, RR produktion Hurtig
    const html = h.els.rdProducesBody.innerHTML;
    const fremme = html.split('<details')[0];
    assert.match(fremme, /Chili Mayo/);
    assert.match(fremme, /leveres/, 'on_demand står ikke fremme');
    assert.ok(!/[Kk]ostpris/.test(fremme), 'kostpris-forklaringen står fremme i stedet for bag folden');
    assert.match(html, /<details/, 'der er ingen fold at lægge forklaringen i');
    assert.match(html.split('<details')[1], /[Kk]ostpris/, 'forklaringen mangler bag folden');
    // Uden advarsler er der præcis ÉN tekst-blok fremme (selve pillen tæller ikke).
    assert.equal((fremme.match(/rd-produces-note/g) || []).length, 1,
        'der står mere end én tekst-blok fremme: ' + fremme);

    const h2 = await openDesigner(SNAP, 14);             // Rødløg, RR Produktion → to_stock
    const fremme2 = h2.els.rdProducesBody.innerHTML.split('<details')[0];
    assert.ok(!/leveres/.test(fremme2), 'to_stock må ikke love automatisk produktion ved levering');
    assert.match(fremme2, /lager/);
});

test('§10 en advarsel gemmes aldrig bag folden', async () => {
    const snap = withSnap(s => { s.recipes.find(r => r.id === 110).userfields.recipeunitnumber = ''; });
    const h = await openDesigner(snap, 110);
    const fremme = h.els.rdProducesBody.innerHTML.split('<details')[0];
    assert.match(fremme, /Udbyttet mangler/, 'advarslen står ikke fremme');
    assert.match(fremme, /rd-produces-warn/);
});

test('§10 enhedslisten skiller måleenheder fra Timer og Kr', async () => {
    // `Timer` og `Kr` ER i brug — på x- Service-opskrifterne. De må ikke
    // fjernes (#680), men de er ikke måleenheder og skal stå for sig.
    const snap = withSnap(s => {
        s.recipes.find(r => r.id === 97).userfields.recipeunit = 'Timer';
        s.recipes.find(r => r.id === 118).userfields.recipeunit = 'Kr';
    });
    const h = await openDesigner(snap, 110);
    const html = h.run('_rdUnitOptionsHtml("kg")');
    const grupper = [...html.matchAll(/<optgroup label="([^"]+)">([\s\S]*?)<\/optgroup>/g)]
        .map(m => [m[1], [...m[2].matchAll(/value="([^"]*)"/g)].map(v => v[1])]);
    const maal = (grupper.find(g => /Måleenhed/.test(g[0])) || [, []])[1];
    const andet = (grupper.find(g => /Ikke en/.test(g[0])) || [, []])[1];
    assert.ok(maal.includes('kg') && maal.includes('antal'), 'kg/antal mangler blandt måleenhederne: ' + maal);
    assert.ok(andet.includes('Timer') && andet.includes('Kr'), 'Timer/Kr står som måleenheder: ' + andet);
    assert.ok(!maal.includes('Timer'), 'Timer står som måleenhed');
    // Ingen værdi må forsvinde — det var præcis #680's fejl.
    assert.ok(html.includes('value="Timer"') && html.includes('value="Kr"'),
        'en enhed i brug forsvandt fra listen');
});

// ── §11 Advarslen skal kunne handles på ───────────────────────
//
// `RecipeYield` giver op tre forskellige steder, og de kræver hver sin
// handling. Den samme tekst til alle tre ville bede om at udfylde et felt der
// i to af tilfældene allerede står der — og en anvisning der ikke passer,
// lærer folk at ignorere advarslen (samme svigt som vagthunden i #359).

const yieldStatus = (h, over) => {
    h.ctx.__y = Object.assign({ yieldNum: 1.1, recipeUnit: 'kg', baseServings: 1 }, over || {});
    h.ctx.__p = SNAP.products.find(p => p.id === 34);   // Chili Mayo, lagerføres i Kilo
    return h.run('_rdYieldStatus(__y, __p, _rdQuUnitList, _rdQuConversions)');
};

test('§11 årsagen navngives — ikke bare "kan ikke bestemmes"', async () => {
    const h = await openDesigner(SNAP, 110);
    assert.equal(yieldStatus(h).reason, null, 'et gyldigt udbytte må ikke have en årsag');
    assert.equal(yieldStatus(h, { yieldNum: null }).reason, 'mangler_tal');
    assert.equal(yieldStatus(h, { recipeUnit: 'Timer' }).reason, 'ukendt_enhed');
    assert.equal(yieldStatus(h, { recipeUnit: '' }).reason, 'ukendt_enhed');
    // Begge felter udfyldt og enheden er ægte — men ingen ved hvad ét antal vejer.
    assert.equal(yieldStatus(h, { recipeUnit: 'antal' }).reason, 'mangler_omregning');
});

test('§11 hver årsag får sin egen handling', async () => {
    const h = await openDesigner(SNAP, 110);
    const raad = (over) => {
        Object.assign(h.ctx, {});
        h.run('_rdDs.yieldNum = ' + (over.yieldNum === null ? 'null' : over.yieldNum || 1.1));
        h.run('_rdDs.recipeUnit = ' + JSON.stringify(over.recipeUnit == null ? 'kg' : over.recipeUnit));
        return h.run('_rdYieldAdvice(_rdProducesImpact(34))');
    };

    const tomt = raad({ yieldNum: null });
    assert.match(tomt, /Skriv i feltet/, 'tomt tal: ' + tomt);

    const timer = raad({ recipeUnit: 'Timer' });
    assert.match(timer, /Timer/, 'enheden nævnes ikke: ' + timer);
    assert.match(timer, /[Vv]ælg/, 'der peges ikke på at vælge en anden enhed: ' + timer);
    assert.ok(!/Skriv i feltet/.test(timer), 'beder om at udfylde et tal der allerede står der');

    const antal = raad({ recipeUnit: 'antal' });
    assert.match(antal, /Kilo/, 'lager-enheden nævnes ikke: ' + antal);
    assert.match(antal, /vejer/, 'den anden udvej (hvad ét antal vejer) nævnes ikke: ' + antal);
    assert.ok(!/Skriv i feltet "1 portion er" ovenfor hvor meget/.test(antal),
        'beder om at udfylde noget der allerede står der');

    assert.ok(new Set([tomt, timer, antal]).size === 3, 'to af de tre siger det samme');
});

test('§11 _rdYieldStatus er ALTID enig med RecipeYield', async () => {
    // Et parallelt regnestykke ville drive fra kostprisen og produktionsbatchen,
    // og så ville designeren vise ét tal mens lageret fik et andet (#360).
    const h = await openDesigner(SNAP, 110);
    const produkter = [34, 231, 226];                       // Kilo-varer, én med antal→kilo
    const enheder = ['kg', 'gram', 'liter', 'antal', 'Timer', 'Kr', '', 'vrøvl'];
    const tal = [1, 1.1, 0, null, 64];
    let kombinationer = 0, uenige = [];
    for (const pid of produkter) for (const u of enheder) for (const n of tal) for (const b of [1, 64]) {
        kombinationer++;
        h.ctx.__y = { yieldNum: n, recipeUnit: u, baseServings: b };
        h.ctx.__p = SNAP.products.find(p => p.id === pid);
        h.ctx.__r = { userfields: { recipeunitnumber: n == null ? '' : String(n), recipeunit: u }, base_servings: b };
        const mit = h.run('_rdYieldStatus(__y, __p, _rdQuUnitList, _rdQuConversions)').amount;
        const deres = h.run('RecipeYield.yieldInStockUnits(__r, __p, _rdQuUnitList, _rdQuConversions)');
        const ens = (mit == null && deres == null) || (mit != null && deres != null && Math.abs(mit - deres) < 1e-9);
        if (!ens) uenige.push(`vare ${pid}, ${n} ${u}, base ${b}: designer=${mit} RecipeYield=${deres}`);
    }
    assert.equal(kombinationer, 240, 'gitteret blev mindre end det skulle være');
    assert.deepEqual(uenige, [], 'designeren og RecipeYield er uenige');
});

test('§11 advarslen om en inaktiv vare siger hvor man henter den frem', async () => {
    const h = await openDesigner(SNAP, 110);
    const p = clone(SNAP.products.find(x => x.id === 34));
    p.active = '0';
    h.ctx.__im = impactBase({ product: p });
    const info = h.run('_rdProducesInfo(_rdComputeProducesImpact(__im))');
    const linje = info.warnings.find(l => /lagt væk|inaktiv/i.test(l));
    assert.ok(linje, 'inaktiv vare nævnes ikke: ' + JSON.stringify(info.warnings));
    assert.match(linje, /Lageroversigt/, 'der peges ikke på hvor den hentes frem: ' + linje);
});

test('§11 to opskrifter om samme vare siger hvad man gør ved det', async () => {
    const h = await openDesigner(SNAP, 110);
    const rs = clone(SNAP.recipes);
    rs.find(r => r.id === 97).product_id = 34;
    h.ctx.__im = impactBase({ recipes: rs });
    const info = h.run('_rdProducesInfo(_rdComputeProducesImpact(__im))');
    const linje = info.warnings.find(l => /laver også/.test(l));
    assert.ok(linje, 'dobbelt producent nævnes ikke');
    assert.match(linje, /fjern varen/i, 'der står ikke hvad man gør: ' + linje);
});

// ── §12 Én vælger, ikke to ────────────────────────────────────
//
// "+ Tilføj ingrediens" og "Producerer vare" gør det samme: find varen, eller
// opret den hvis den ikke findes i Grocy endnu. De var skrevet hver for sig og
// havde efter én dag allerede hver sit filter.

test('§12 de to vælgere slår det SAMME op', async () => {
    const h = await openDesigner(SNAP, 77);
    const ider = (dd) => [...dd.innerHTML.matchAll(/data-pid="(\d+)"/g)].map(m => m[1]);
    for (const q of ['mayo', 'a', 'salat', 'chili']) {
        h.run(`_rdOnAcInput(${JSON.stringify(q)})`);
        h.run(`_rdOnProdAcInput(${JSON.stringify(q)})`);
        assert.deepEqual(ider(h.els.rdAcDropdown), ider(h.els.rdProdAcDropdown),
            `"${q}": ingredienserne og "producerer vare" er uenige om hvilke varer der findes`);
    }
});

test('§12 ingrediens-vælgeren udelader også inaktive varer', async () => {
    // Var kun den ene filtreret, kunne man lægge en inaktiv vare ind som
    // ingrediens — og den kan ikke forbruges (#645).
    const snap = withSnap(s => { s.products.find(p => p.id === 34).active = '0'; });
    const h = await openDesigner(snap, 77);
    h.run('_rdOnAcInput("chili mayo")');
    assert.ok(!/data-pid="34"/.test(h.els.rdAcDropdown.innerHTML),
        'den inaktive vare kunne vælges som ingrediens');

    const h2 = await openDesigner(SNAP, 77);
    h2.run('_rdOnAcInput("chili mayo")');
    assert.match(h2.els.rdAcDropdown.innerHTML, /data-pid="34"/,
        'den aktive vare mangler — så måler testen ovenfor ingenting');
});

test('§12 de to vælgere viser HVER SIT, men henter fra samme sted', async () => {
    const h = await openDesigner(SNAP, 77);
    h.run('_rdOnAcInput("chili mayo")');
    h.run('_rdOnProdAcInput("chili mayo")');
    assert.match(h.els.rdAcDropdown.innerHTML, /&#9679;/, 'ingredienserne mangler lager-prikken');
    assert.match(h.els.rdProdAcDropdown.innerHTML, /laves allerede af/, '"producerer vare" mangler producenten');
    assert.ok(!/laves allerede af/.test(h.els.rdAcDropdown.innerHTML),
        'ingrediens-listen viser producent-teksten');
});

test('§12 begge steder kan oprette en vare der ikke findes endnu', async () => {
    const h = await openDesigner(SNAP, 77);
    // Ingrediens-panelet: knappen findes OG er bundet.
    assert.ok(h.els.rdAddNewProduct, 'ingrediens-panelet har ingen "opret ny vare"');
    assert.ok((h.els.rdAddNewProduct._listeners.click || []).length,
        '"opret ny vare" i ingrediens-panelet er ikke bundet til noget');
    // "Producerer vare"-panelet: samme.
    assert.ok((h.els.rdProdNew._listeners.click || []).length,
        '"opret ny vare" ved produceret vare er ikke bundet til noget');

    // Begge går gennem ÉN indgang — den der monterer shared/product_create.js.
    const kaldt = [];
    h.ctx._rdOpenProductCreate = (o) => kaldt.push(o.title);
    h.run('_rdCreateIngredientProduct()');
    h.run('_rdCreateProducedProduct()');
    assert.equal(kaldt.length, 2, 'en af dem går uden om den fælles indgang');
    assert.match(kaldt[0], /ingrediens/i);
    assert.match(kaldt[1], /produceres af/i);
});

test('§12 en nyoprettet vare vælges — man skal kun skrive mængden', async () => {
    const h = await openDesigner(SNAP, 77);
    let genindlæst = 0;
    h.ctx._rdLoadData = () => { genindlæst++; return Promise.resolve(); };
    let onCreated = null;
    h.ctx.initProductCreate = (el, o) => { onCreated = o.onCreated; };
    h.ctx.cleanupProductCreate = () => {};

    h.run('_rdToggleAddPanel()');
    h.run('_rdCreateIngredientProduct()');
    assert.ok(onCreated, 'product_create blev ikke monteret');
    await onCreated(34, 'Chili Mayo');
    assert.equal(genindlæst, 1, 'varen blev ikke hentet ind i designerens hukommelse');
    assert.equal(h.run('_rdSelectedProduct && _rdSelectedProduct.id'), 34,
        'den nye vare blev ikke valgt — man skal vælge den selv bagefter');

    h.run('_rdCreateProducedProduct()');
    await onCreated(34, 'Chili Mayo');
    assert.equal(h.run('_rdDs.productId'), 34, 'den nye vare blev ikke sat som produceret vare');
});
