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
const SRC = ['shared/grocy_num.js', 'shared/moms.js', 'shared/recipe_designer.js']
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
