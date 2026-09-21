// scripts/test-recipe-editor-state.js
// ============================================================
// Editorens tilstand må ikke overleve et skift af opskrift (§13).
//
// `recipe_editor.js` holder ÉN modul-tilstand (`S`) for den opskrift der er
// åben. Flere felter blev sat løbende uden at være deklareret — og derfor
// glemt da `mount` ryddede op felt for felt. Resultatet så man i drift:
// lav fritekst om til trin på «Rødkål - Syltet», gå tilbage, åbn «Langtids
// stegt Gris» — og den viste Rødkålens fremgangsmåde med «1 ændring siden
// sidste gem». Et tryk på Gem ville have skrevet den ind i Grisens opskrift.
//
// Det er ikke en visningsfejl. Derfor måler testen ikke hvad skærmen viser,
// men hvad der ville blive SENDT til serveren.
//
// Browser-kode kan ikke require's, så den rigtige fil køres i en vm-sandkasse
// med en DOM der er netop rig nok til at klik-handleren kan fyre.
//
// Kør:  node scripts/test-recipe-editor-state.js
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

/* ── DOM-attrap ───────────────────────────────────────────────
   Kun det editoren rører. `addEventListener` på roden fanges, så vi kan
   fyre de ÆGTE handlere — en test der kaldte de interne funktioner direkte
   ville ikke bevise at knapperne er koblet til dem. */
function lavEl(id) {
    const e = {
        id: id || '', value: '', innerHTML: '', textContent: '', dataset: {},
        style: {}, _lyttere: {},
        classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
        querySelector: () => null, querySelectorAll: () => [],
        appendChild() {}, remove() {}, removeAttribute() {}, setAttribute() {},
        scrollIntoView() {}, focus() {}, closest: () => null,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
        addEventListener(t, f) { (this._lyttere[t] = this._lyttere[t] || []).push(f); },
        _fyr(t, ev) { (this._lyttere[t] || []).forEach(f => f(ev)); },
    };
    return e;
}

const els = {};
const byId = (id) => (els[id] || (els[id] = lavEl(id)));

const fetches = [];
const sandbox = {
    console, setTimeout, clearTimeout, JSON, Math, Date, Number, String, Object, Array, Set, Map,
    document: {
        getElementById: byId,
        querySelector: () => null, querySelectorAll: () => [],
        createElement: () => lavEl(''), addEventListener() {}, body: lavEl('body'),
    },
    localStorage: { getItem: () => null, setItem() {} },
    confirm: () => true,
    esc: (s) => String(s == null ? '' : s),
    fetch: async (sti, opts) => {
        fetches.push({ sti, body: opts && opts.body ? JSON.parse(opts.body) : null });
        return { ok: true, status: 200, text: async () => JSON.stringify({ recipe_id: 1, change_count: 1 }) };
    },
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// De rigtige hjælpemoduler — ikke stubs. Driver de fra editoren, skal det ses.
for (const f of ['recipe_steps.js', 'recipe_lines.js', 'recipe_diff.js']) {
    const p = path.join(__dirname, '..', 'shared', f);
    if (fs.existsSync(p)) vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: f });
}
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared', 'recipe_editor.js'), 'utf8'),
    sandbox, { filename: 'recipe_editor.js' });

const RE = sandbox.window.RecipeEditor;
const S = RE._state;

const META = { grupper: ['RR Produktion'], units: [], products: [], groups: [] };
const kladde = (id, navn, beskrivelse) => ({
    recipe_id: id, name: navn, group: 'RR Produktion', base_servings: 1,
    description: beskrivelse, yield: { amount: 1, unit: 'kg', product_id: null },
    target_weight_g: null, lines: [],
});

/* Klikker som brugeren gør: gennem rodens click-lytter, med et event hvis
   target.closest('button') giver knappen. */
function klik(attrs) {
    const knap = Object.assign(lavEl(attrs.id || ''), { dataset: attrs.dataset || {} });
    S.el._fyr('click', { target: { closest: (sel) => (sel === 'button' ? knap : null) }, preventDefault() {}, stopPropagation() {} });
}

(async () => {

const A = kladde(14, 'Rødkål - Syltet', '<p>Rødkålen snittes</p><p>Lagen koges</p>');
const B = kladde(53, 'Langtids stegt Gris', '<p>Grisen gnides med salt</p>');

// ── §1 Drifts-forløbet: A → trin → B ──────────────────────────
console.log('\n── §1 En anden opskrift arver ikke den forriges trin ──────');
{
    await RE.mount(byId('rod'), { draft: A, meta: META, overview: {}, mode: 'modify' });
    ok(S.stepsEdited == null, 'frisk mount har ingen trin-ændringer');

    klik({ dataset: { act: 'plain2steps' } });
    ok(S.stepsEdited && S.stepsEdited.steps && S.stepsEdited.steps.length === 2,
        `«Lav om til trin» laver A's to linjer om til trin (fik ${S.stepsEdited && S.stepsEdited.steps ? S.stepsEdited.steps.length : 'ingen'})`);

    // Præcis det brugeren gjorde: væk fra A, ind i B.
    await RE.mount(byId('rod'), { draft: B, meta: META, overview: {}, mode: 'modify' });

    ok(S.stepsEdited == null, 'B åbner UDEN A’s trin-ændringer');
    // `stepsParsed` er en cache af den parsede beskrivelse. Den fyldes igen
    // med det samme af renderingen — pointen er HVIS beskrivelse den er
    // parset af. Bar den A's, ville B's fremgangsmåde aldrig blive læst.
    const parsetTekst = JSON.stringify(S.stepsParsed || {});
    ok(/Grisen/.test(parsetTekst) && !/Rødkålen/.test(parsetTekst),
        'og den parsede beskrivelse er B’s egen — ikke A’s cachede');

    // Det afgørende: hvad ville blive GEMT? En assert på tilstanden alene
    // kunne bestå selvom teksten stadig fulgte med ud til Grocy.
    fetches.length = 0;
    klik({ id: 'reSave' });
    await new Promise(r => setTimeout(r, 0));
    const sendt = fetches.find(f => /\/gem|\/ny/.test(f.sti));
    ok(!!sendt, 'Gem sender kladden til serveren');
    const d = (sendt && sendt.body && sendt.body.description) || '';
    ok(/Grisen/.test(d), `det der gemmes er B’s egen beskrivelse (${JSON.stringify(d.slice(0, 40))})`);
    ok(!/Rødkålen/.test(d), 'og IKKE A’s — det var fejlen: Rødkålens tekst ind i Grisens opskrift');
}

// ── §2 Kassér lader intet ligge ───────────────────────────────
console.log('\n── §2 Kassér gendanner den næste opskrift ────────────────');
{
    await RE.mount(byId('rod'), { draft: kladde(14, 'Rødkål - Syltet', '<p>Rødkålen snittes</p>'), meta: META, overview: {}, mode: 'modify' });
    klik({ dataset: { act: 'plain2steps' } });
    ok(S.stepsEdited != null, 'der ER en ændring at kassere');

    let forladt = false;
    S.onExit = () => { forladt = true; };
    klik({ id: 'reDiscard' });
    ok(forladt, 'Kassér forlader editoren');

    // Samme opskrift åbnes igen — friskt hentet fra serveren.
    await RE.mount(byId('rod'), { draft: kladde(14, 'Rødkål - Syltet', '<p>Rødkålen snittes</p>'), meta: META, overview: {}, mode: 'modify' });
    ok(S.stepsEdited == null, 'genåbning viser den gemte tekst, ikke de kasserede trin');
}

// ── §3 Intet felt kan glemmes igen ────────────────────────────
// Fejlens rod var ikke de to felter, men at de kunne sættes uden at være
// deklareret. Testen holder fast i at tilstanden nulstilles i ét greb.
console.log('\n── §3 Alle felter nulstilles, ikke kun dem nogen huskede ──');
{
    await RE.mount(byId('rod'), { draft: A, meta: META, overview: {}, mode: 'modify' });
    // Sæt ALT der kan bære over — som brugen ville have gjort.
    S.stepsEdited = { steps: [{ text: 'x', minutes: null }] };
    S.stepsParsed = { mode: 'raw', plain: 'x', steps: [] };
    S.expandData = { 'linje-1': { lines: [] } };
    S.editLineKey = 'linje-1';
    S.menu = { key: 'linje-1' };
    S.priceTarget = 42;
    S.review = { open: true };
    S.newLine = { name: 'halvfærdig vare' };
    S.expanded.add('linje-1');

    await RE.mount(byId('rod'), { draft: B, meta: META, overview: {}, mode: 'modify' });

    const rester = ['stepsEdited', 'expandData', 'editLineKey', 'menu', 'priceTarget', 'review', 'newLine']
        .filter(k => S[k] != null);
    ok(rester.length === 0, `intet følger med til den næste opskrift (rester: ${rester.join(', ') || 'ingen'})`);
    // `stepsParsed` er undtaget ovenfor fordi renderingen fylder den igen —
    // men så skal den være fyldt af den RIGTIGE opskrift.
    ok(!/x/.test(JSON.stringify((S.stepsParsed || {}).plain || '')),
        'og den genfyldte beskrivelses-cache er den nye opskrifts');
    ok(S.expanded.size === 0, 'heller ikke hvilke linjer der var foldet ud');
}

// ── §4 Tælleren for /beregn må IKKE nulstilles ────────────────
// Den hører bevidst uden for friskTilstand(): sættes den til 0 ved hvert
// mount, kan et svar fra den forrige opskrift stadig være «nyt nok».
console.log('\n── §4 Et gammelt /beregn-svar kan ikke overhale ──────────');
{
    await RE.mount(byId('rod'), { draft: A, meta: META, overview: {}, mode: 'modify' });
    const før = S.calcSeq;
    await RE.mount(byId('rod'), { draft: B, meta: META, overview: {}, mode: 'modify' });
    ok(S.calcSeq > før, `tælleren går FREM ved mount (${før} → ${S.calcSeq}), den nulstilles ikke`);
}

// ── §4b En igangværende hentning må ikke lande i den nye opskrift ──
// Ændrer man antallet på en udfoldet linje, sættes en timer der henter
// udfoldningen igen 350 ms senere. Skifter man opskrift imens, ville den
// fyre ind i en opskrift den intet har med at gøre — og skrive sit svar
// ned i `expandData` under en nøgle den nye liste også bruger («i1»).
console.log('\n── §4b En hentning på vej afbrydes ved skift ─────────────');
{
    const medLinjer = () => ({
        recipe_id: 14, name: 'Rødkål - Syltet', group: 'RR Produktion', base_servings: 1,
        description: '<p>Rødkålen snittes</p>', yield: { amount: 1, unit: 'kg', product_id: null },
        target_weight_g: null,
        lines: [{ product_id: 1, amount: 2, section: 'Fyld' }, { semi_recipe_id: 110, product_id: 9, amount: 1 }],
    });
    const ov = { lines: [{ draft_index: 0, name: 'Vare', weight_g: 1 },
                         { draft_index: 1, name: 'Chili Mayo', semi_recipe_id: 110 }] };

    await RE.mount(byId('rod'), { draft: medLinjer(), meta: META, overview: ov, mode: 'modify' });
    klik({ dataset: { act: 'expand', key: 'i1' } });      // fold halvfabrikatet ud
    await new Promise(r => setTimeout(r, 0));
    ok(S.expanded.has('i1'), 'linjen er foldet ud');

    fetches.length = 0;
    klik({ dataset: { act: 'inc', key: 'i1' } });          // antal ændret → timer sat
    ok(S._udfoldT != null, 'og en genhentning er sat i gang');

    // Skift opskrift, og vent forbi de 350 ms timeren venter.
    await RE.mount(byId('rod'), { draft: B, meta: META, overview: {}, mode: 'modify' });
    fetches.length = 0;
    await new Promise(r => setTimeout(r, 450));
    const efter = fetches.filter(f => /\/indhold/.test(f.sti));
    ok(efter.length === 0, `ingen udfoldning hentes ind i den nye opskrift (fik ${efter.length})`);
}

// ── §5 Kolonnevælgeren lover kun kolonner der findes ──────────
console.log('\n── §5 Ingen pille uden kolonne ───────────────────────────');
{
    await RE.mount(byId('rod'), { draft: A, meta: META, overview: {}, mode: 'modify' });
    ok(!('allergen' in S.columns),
        'allergen-pillen er væk — den tændte, men der er ingen allergen-kolonne');
    const kendte = Object.keys(S.columns).sort().join(',');
    ok(kendte === 'co2,cost,gram,stock', `kolonnerne er dem listen faktisk tegner (${kendte})`);

    // En gammel localStorage-værdi må ikke genoplive den.
    sandbox.localStorage.getItem = () => JSON.stringify({ gram: false, allergen: true, fremtid: true });
    await RE.mount(byId('rod'), { draft: A, meta: META, overview: {}, mode: 'modify' });
    ok(!('allergen' in S.columns) && !('fremtid' in S.columns),
        'og en gemt, ukendt kolonne skrives ikke tilbage');
    ok(S.columns.gram === false, 'mens en gemt KENDT kolonne stadig respekteres');
    sandbox.localStorage.getItem = () => null;
}

console.log(fail ? `\n\x1b[31m${pass} PASS · ${fail} FAIL\x1b[0m\n`
                 : `\n\x1b[32m${pass} PASS · 0 FAIL\x1b[0m\n`);
process.exit(fail ? 1 : 0);
})();
