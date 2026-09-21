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
const nær = (a, b, eps = 1e-9) => a != null && b != null && Math.abs(a - b) < eps;

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
        // Understøtter `{signal}` som browseren gør — ellers kan testen ikke
        // se om lytterne hober sig op ved gentagne mounts.
        addEventListener(t, f, o) {
            const rec = { f };
            (this._lyttere[t] = this._lyttere[t] || []).push(rec);
            if (o && o.signal) o.signal.addEventListener('abort', () => {
                this._lyttere[t] = this._lyttere[t].filter(x => x !== rec);
            });
        },
        _fyr(t, ev) { (this._lyttere[t] || []).slice().forEach(r => r.f(ev)); },
        _antal(t) { return (this._lyttere[t] || []).length; },
    };
    return e;
}

const els = {};
const byId = (id) => (els[id] || (els[id] = lavEl(id)));

const fetches = [];
const sandbox = {
    console, setTimeout, clearTimeout, JSON, Math, Date, Number, String, Object, Array, Set, Map, AbortController,
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

// ── §6 Mængden redigeres i det man SER ────────────────────────
// Feltet viser linjens egen enhed («2 Antal»), kladden bærer lager-enheden
// (0,0133 kg). Uden konverteringen tilbage ville et rettet tal blive gemt
// i en anden enhed end det blev tastet i — #352, faktor 1000 galt.
console.log('\n── §6 Et rettet tal gemmes i lager-enhed ─────────────────');
{
    // Serveren siger: 0,03 kg vises som «30 Gram», faktor 1000.
    const draft = kladde(26, 'Italieneren', '<p>x</p>');
    draft.lines = [{ id: 9, product_id: 34, amount: 0.03, qu_id: 5 }];
    const ov = { lines: [{ draft_index: 0, name: 'Chili Mayo', unit: 'Gram',
                           amount_stock: 0.03, display_amount: 30, display_factor: 1000,
                           weight_g: 30 }] };
    await RE.mount(byId('rod'), { draft, meta: META, overview: ov, mode: 'modify' });

    const vist = S.lines.lines[0];
    ok(vist.amount === 30, `feltet viser 30, ikke 0,03 (fik ${vist.amount})`);
    ok(vist.amount_stock === 0.03, 'men linjen husker lager-enheden ved siden af');

    // Brugeren taster 45 i feltet.
    S.el._fyr('input', { target: { id: '', dataset: { act: 'amount', key: vist.key }, value: '45' } });
    ok(nær(S.draft.lines[0].amount, 0.045, 1e-9),
        `45 Gram gemmes som 0,045 kg — ikke 45 (fik ${S.draft.lines[0].amount})`);

    // ± tæller i det man ser: ét gram mere, ikke ét kilo.
    klik({ dataset: { act: 'inc', key: vist.key } });
    ok(nær(S.draft.lines[0].amount, 0.046, 1e-9),
        `«+» giver ét gram mere (fik ${S.draft.lines[0].amount} kg)`);
    // Og FELTET skal følge med straks. Læste det serverens `display_amount`,
    // stod det med det gamle tal indtil /beregn svarede — man trykker «+»,
    // kladden ændrer sig, og skærmen viser noget andet. Fanget i browseren,
    // ikke her: den første udgave af testen målte kun kladden.
    ok(S.lines.lines[0].amount === 46,
        `og feltet viser 46 med det samme (fik ${S.lines.lines[0].amount})`);
    klik({ dataset: { act: 'dec', key: vist.key } });
    ok(nær(S.draft.lines[0].amount, 0.045, 1e-9), 'og «−» tager det igen');

    // Og det gælder også det FAKTISKE input: gentegningen bevarer brugerens
    // råtekst mens feltet har fokus (ellers tegnes «0,» som «0» midt i en
    // indtastning), så ± skal skrive det nye tal selv. Uden det står feltet
    // på det gamle tal mens alt andet er opdateret — set i browseren, ikke her.
    const inp = byId('_felt_i0');
    inp.dataset.act = 'amount'; inp.dataset.key = vist.key; inp.value = 'noget gammelt';
    S.el.querySelector = (sel) => (/data-act="amount"/.test(sel) ? inp : null);
    klik({ dataset: { act: 'inc', key: vist.key } });
    ok(inp.value === '46', `og selve feltet får det nye tal skrevet i sig (fik ${inp.value})`);

    // En linje serveren ikke har set endnu: feltet og kladden er samme enhed.
    const ny = kladde(null, 'ZZT ny', '');
    ny.lines = [{ product_id: 34, amount: 2 }];
    await RE.mount(byId('rod'), { draft: ny, meta: META, overview: { lines: [
        { draft_index: 0, name: 'Chili Mayo', unit: 'Kilo', amount_stock: 2 }] }, mode: 'new' });
    S.el._fyr('input', { target: { id: '', dataset: { act: 'amount', key: S.lines.lines[0].key }, value: '5' } });
    ok(S.draft.lines[0].amount === 5,
        `uden en faktor fra serveren gemmes tallet som tastet (fik ${S.draft.lines[0].amount})`);

    // Udfoldningen skaleres af serveren og skal have LAGER-enheden med.
    // Sendt råt ville «30 Gram» folde halvfabrikatet tusind gange for stort ud.
    const medSemi = kladde(26, 'Italieneren', '<p>x</p>');
    medSemi.lines = [{ id: 9, semi_recipe_id: 110, product_id: 34, amount: 0.03, qu_id: 5 }];
    await RE.mount(byId('rod'), { draft: medSemi, meta: META, overview: {
        lines: [{ draft_index: 0, name: 'Chili Mayo', unit: 'Gram', semi_recipe_id: 110,
                  amount_stock: 0.03, display_amount: 30, display_factor: 1000 }] }, mode: 'modify' });
    fetches.length = 0;
    klik({ dataset: { act: 'expand', key: S.lines.lines[0].key } });
    await new Promise(r => setTimeout(r, 0));
    const kald = fetches.find(f => /\/indhold/.test(f.sti));
    ok(!!kald, 'udfoldningen henter indholdet');
    const brug = kald && decodeURIComponent((kald.sti.match(/bruger=([^&]*)/) || [])[1] || '');
    ok(brug === '0.03', `og beder om 0,03 (lager-enhed) — ikke 30 (fik ${brug})`);
}

// ── §7 Lytterne hober sig ikke op ─────────────────────────────
// Rod-elementet overlever et skift af opskrift. Blev lytterne ikke fjernet
// først, fyrede ét klik lige så mange gange som antallet af opskrifter man
// havde åbnet — og en toggle endte hvor den startede ved hver ANDEN. Det er
// dét der i drift så ud som om kolonne-pillerne og udfoldningen «ikke virker»:
// de virkede, bare to gange.
console.log('\n── §7 Ét klik er ét klik, uanset hvor mange opskrifter ───');
{
    const rod = byId('rod');
    const resultater = [];
    for (let n = 1; n <= 5; n++) {
        await RE.mount(rod, { draft: kladde(n, 'R' + n, '<p>x</p>'), meta: META, overview: {}, mode: 'modify' });
        const før = !!S.columns.gram;
        klik({ dataset: { act: 'col', col: 'gram' } });
        resultater.push({ mount: n, lyttere: rod._antal('click'), skiftede: før !== !!S.columns.gram });
    }
    const døde = resultater.filter(r => !r.skiftede);
    ok(døde.length === 0,
        `pillen skifter ved hvert mount (døde klik ved mount: ${døde.map(r => r.mount).join(', ') || 'ingen'})`);
    ok(resultater.every(r => r.lyttere === 1),
        `og der er præcis én click-lytter hele vejen (${resultater.map(r => r.lyttere).join(',')})`);

    // Samme for udfoldningen — den er en toggle på samme måde.
    const medSub = kladde(7, 'Med halvfabrikat', '<p>x</p>');
    medSub.lines = [{ semi_recipe_id: 110, product_id: 9, amount: 1 }];
    const ovSub = { lines: [{ draft_index: 0, name: 'Chili Mayo', semi_recipe_id: 110, unit: 'Kilo', amount_stock: 1 }] };
    await RE.mount(rod, { draft: medSub, meta: META, overview: ovSub, mode: 'modify' });
    await RE.mount(rod, { draft: medSub, meta: META, overview: ovSub, mode: 'modify' });  // lige antal
    klik({ dataset: { act: 'expand', key: 'i0' } });
    ok(S.expanded.has('i0'), 'og udfoldningen åbner ved ét klik, også efter to mounts');
}

// ── §8 ± kommer først frem når man går i tallet ───────────────
// To knapper ved hver anden linje gør en liste man LÆSER til en række
// kontroller. De er derfor skjult indtil feltet har fokus — og så skal
// klikket på dem ikke selv fjerne dem igen.
console.log('\n── §8 ± vises kun ved fokus ──────────────────────────────');
{
    const css = fs.readFileSync(path.join(__dirname, '..', 'shared', 'recipe_editor.css'), 'utf8');
    ok(/\.re-step\s*\{[^}]*visibility:\s*hidden/s.test(css),
        'knapperne er skjulte som udgangspunkt');
    ok(/\.re-qty:focus-within\s+\.re-step\s*\{[^}]*visibility:\s*visible/.test(css),
        'og kommer frem når mængdefeltet har fokus');
    ok(!/\.re-step\s*\{[^}]*display:\s*none/s.test(css),
        'skjult med `visibility`, ikke `display` — pladsen skal blive stående, ellers hopper kolonnen');

    // Uden preventDefault flytter mousedown fokus væk fra feltet, knappen
    // bliver skjult igen, og klikket når aldrig frem.
    await RE.mount(byId('rod'), { draft: A, meta: META, overview: {}, mode: 'modify' });
    let afvist = false;
    const stepKnap = { closest: (sel) => (sel === '.re-step' ? {} : null) };
    S.el._fyr('mousedown', { target: stepKnap, preventDefault() { afvist = true; } });
    ok(afvist, 'et tryk på ± holder fokus i feltet, så knappen ikke forsvinder under fingeren');

    let andet = false;
    S.el._fyr('mousedown', { target: { closest: () => null }, preventDefault() { andet = true; } });
    ok(!andet, 'kontrol: alt andet må stadig få fokus som normalt');
}

// ── §9 Ingen knap der taber sit indhold ───────────────────────
// «Sæt svind» skrev `waste_pct` på linjen og viste annotationen — men
// feltet findes hverken i kladden, på serveren eller i Grocy, så noten
// forsvandt ved næste Gem. Samme klasse som allergen-pillen: en kontrol
// der ser ud til at virke og ikke gør.
console.log('\n── §9 «Sæt svind» er væk indtil den kan gemmes ───────────');
{
    const editor = fs.readFileSync(path.join(__dirname, '..', 'shared', 'recipe_editor.js'), 'utf8');
    ok(!/'waste'/.test(editor), '⋯-menuen tilbyder ikke længere at sætte svind');
    ok(!/function sætSvind/.test(editor), 'og funktionen bag den er fjernet, ikke bare skjult');

    // Læseren bliver: importen producerer annotationen (I2), og den skal
    // kunne vises den dag feltet har et sted at bo.
    const linjer = fs.readFileSync(path.join(__dirname, '..', 'shared', 'recipe_lines.js'), 'utf8');
    ok(/function svindTekst/.test(linjer),
        'men visningen bliver stående — importen skal kunne rendere sin annotation');

    // Og den virker stadig, hvis nogen fylder feltet.
    const RL = sandbox.window.RecipeLines;
    const ud = RL.buildList(
        { recipe_id: 1, name: 'x', base_servings: 1, yield: {},
          lines: [{ product_id: 9, amount: 1, waste_pct: 10, waste_label: 'rensesvind' }] },
        { lines: [{ draft_index: 0, name: 'Gulerødder', unit: 'Kilo', amount_stock: 1 }] }, {});
    ok(/10\s*%\s*rensesvind/.test(ud.lines[0].annotation || ''),
        `en kladde med svind viser det stadig (${ud.lines[0].annotation})`);
}

console.log(fail ? `\n\x1b[31m${pass} PASS · ${fail} FAIL\x1b[0m\n`
                 : `\n\x1b[32m${pass} PASS · 0 FAIL\x1b[0m\n`);
process.exit(fail ? 1 : 0);
})();
