#!/usr/bin/env node
/**
 * Links til opskriften: køkken-dashboardets "Lav snart" og råvarer-modalens
 * to link-typer (underopskrifter + kan-laves-råvarer).
 *
 * Køkken-dashboardets rækker linker til `/kitchen/recipes.html?recipe=…`, og
 * kan sende et batch-antal med så vieweren åbner i den mængde der skal laves.
 *
 * Den regel der skal holde: batch-tallet sendes KUN når opskriftens udbytte er
 * oplyst i Grocy. Er det ikke, sætter resolveren `batches: 1` som fallback
 * (`make_status: 'ukendt'`), og et sådant tal må ikke rejse videre som var det
 * en måling — så ville vieweren vise en mængde ingen har regnet.
 *
 * `kitchen/index.html` er browser-kode og kan ikke `require`s. Funktionerne
 * skæres derfor ud af filen og køres i en vm-sandkasse — det er DE SAMME
 * funktioner browseren bruger, ikke en kopi. Samme mønster som
 * `test-recipe-viewer-nested.js`.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, label, got) {
    if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
    else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${got !== undefined ? ` — fik ${JSON.stringify(got)}` : ''}`); }
}
function eq(actual, expected, label) { ok(actual === expected, label, actual); }
// Et kast er et dårligere signal end en rød linje der siger hvad der gik galt:
// uden dette blev en mutation i _paHref til en stak-udskrift, og så lignede den
// et brudt testscript frem for en fanget fejl.
function href(it) { try { return _paHref(it); } catch (e) { return `KASTEDE: ${e.message}`; } }
function tip(it, sub, h) { try { return _paTip(it, sub, h); } catch (e) { return `KASTEDE: ${e.message}`; } }

// ── Hent funktionerne ud af dashboardet ──────────────────────────────────────
const html = fs.readFileSync(path.join(__dirname, '..', 'kitchen', 'index.html'), 'utf8');
function extract(name) {
    // Fra "function <name>(" til den linje der lukker den på samme indryk.
    const start = html.indexOf(`    function ${name}(`);
    if (start === -1) throw new Error(`${name} findes ikke i kitchen/index.html — er den omdøbt?`);
    const end = html.indexOf('\n    }', start);
    if (end === -1) throw new Error(`kunne ikke finde slutningen på ${name}`);
    return html.slice(start, end + 6);
}
const modalSrc = fs.readFileSync(path.join(__dirname, '..', 'shared', 'modal.js'), 'utf8');
function extractTop(src, name, file) {
    const start = src.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`${name} findes ikke i ${file} — er den omdøbt?`);
    const end = src.indexOf('\n}', start);
    if (end === -1) throw new Error(`kunne ikke finde slutningen på ${name}`);
    return src.slice(start, end + 2);
}
// `recipeUrl` bor i shared/utils.js og deles af alle tre link-byggere. Den
// hentes ind i BEGGE sandkasser, så testene rammer den ægte fælles regel og
// ikke hver sin attrap.
const utilsSrc = fs.readFileSync(path.join(__dirname, '..', 'shared', 'utils.js'), 'utf8');
const recipeUrlSrc = extractTop(utilsSrc, 'recipeUrl', 'utils.js');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(recipeUrlSrc + '\n' + extract('_paHref') + '\n' + extract('_paTip'), ctx);
// `_subRecipeLink` får escaperen sendt ind. Sandkassen giver den modalens egen
// `esc`-fallback, så escapingen er den samme kode produktionen falder tilbage
// på — ikke en attrap der kunne være mildere.
vm.runInContext(extractTop(modalSrc, '_subRecipeLink', 'modal.js') + '\n'
              + extractTop(modalSrc, '_makeRecipeLink', 'modal.js'), ctx);
// `_subRecipeNav` læser `document.body.classList` og `document.fullscreenElement`.
// Sandkassen får en DOM lige stor nok til at de to signaler kan styres.
const domCtx = {
    document: {
        body: { classList: { _set: new Set(), contains(c) { return this._set.has(c); } } },
        fullscreenElement: null,
    },
};
vm.createContext(domCtx);
vm.runInContext(extractTop(modalSrc, '_subRecipeNav', 'modal.js'), domCtx);
const { _paHref, _paTip, _subRecipeLink, _makeRecipeLink, recipeUrl } = ctx;
const { _subRecipeNav } = domCtx;

const item = (o) => Object.assign({
    recipe_id: 28, recipe_name: 'Langtids stegt Gris',
    batches: 2, make_status: 'ok', status: 'kan_laves',
}, o);

console.log('\nL1 · Kendt udbytte → batch-tallet sendes med');
eq(href(item({ batches: 2 })), '/kitchen/recipes.html?recipe=28&batches=2',
   '2 batches ender i URL\'en');
eq(href(item({ batches: 1 })), '/kitchen/recipes.html?recipe=28&batches=1',
   '1 batch er også et rigtigt tal og sendes med');
eq(href(item({ make_status: 'mangler', status: 'mangler', batches: 3 })),
   '/kitchen/recipes.html?recipe=28&batches=3',
   'en blokeret række linker OGSÅ — dér ser man hvad der skal købes');

console.log('\nL2 · Ukendt udbytte → vi opfinder ikke en mængde');
eq(href(item({ make_status: 'ukendt', batches: 1 })),
   '/kitchen/recipes.html?recipe=28',
   "make_status 'ukendt' sender INTET batch-tal");
ok(!href(item({ make_status: 'ukendt', batches: 7 })).includes('batches'),
   'heller ikke når fallbacken tilfældigvis er et højere tal',
   href(item({ make_status: 'ukendt', batches: 7 })));

console.log('\nL3 · Uden en opskrift er der intet at linke til');
eq(href(item({ recipe_id: null })), '', 'recipe_id null → intet link');
eq(href(item({ recipe_id: 0 })), '', 'recipe_id 0 → intet link');
eq(href(item({ recipe_id: 'x' })), '', 'recipe_id vrøvl → intet link');
eq(href({}), '', 'tomt item vælter ikke');
eq(href(null), '', 'null vælter ikke');

console.log('\nL4 · Ugyldigt batch-tal er ikke et tal');
for (const b of [0, -2, null, undefined, 'abc', NaN]) {
    ok(!href(item({ batches: b })).includes('batches'),
       `batches=${JSON.stringify(b)} sendes ikke med`, href(item({ batches: b })));
}

console.log('\nL5 · Tooltip gentager ikke navnet');
eq(tip(item({}), 'Langtids stegt Gris', '/x'),
   'Langtids stegt Gris · Åbn opskriften',
   'navnet står allerede i underteksten → "Åbn opskriften"');
eq(tip(item({}), 'mangler Rosiner, Æbler m.fl.', '/x'),
   'mangler Rosiner, Æbler m.fl. · Åbn Langtids stegt Gris',
   'blokeret række: navnet ER ny information');
eq(tip(item({}), '', '/x'), 'Åbn Langtids stegt Gris',
   'tom undertekst giver ingen løs separator');
eq(tip(item({}), 'mangler Salt', ''), 'mangler Salt',
   'uden link tilbydes der ingen handling');

// ── Råvarer-modalens underopskrifter ────────────────────────────────────────
const sub = (o) => Object.assign({
    recipe_id: 41, recipe_name: 'Æggesalat', servings: 2, shortfalls: [],
}, o);
function link(sr) { try { return _subRecipeLink(sr); } catch (e) { return `KASTEDE: ${e.message}`; } }
const subHref = (sr) => (link(sr).match(/href="([^"]*)"/) || [, ''])[1];

console.log('\nS1 · Underopskriften linker til opskriften');
eq(subHref(sub({})), '/kitchen/recipes.html?recipe=41&portions=2',
   'portioner sendes direkte — servings ER portioner');
eq(subHref(sub({ servings: 1.5599999999 })), '/kitchen/recipes.html?recipe=41&portions=1.56',
   'afrundet, så flydende-tal-støj ikke ender i URL\'en');
ok(link(sub({})).includes('target="_blank"'),
   'ny fane — man skal kunne vende tilbage til råvarelisten');
ok(link(sub({})).includes('rel="noopener"'), 'noopener på target=_blank');
ok(link(sub({})).includes('_subRecipeNav(event, this)'),
   'klik går gennem handleren, der standser boblingen så rækken ikke folder ud');

console.log('\nS2 · Uden opskrift er navnet bare tekst');
eq(link(sub({ recipe_id: null })), 'Æggesalat', 'recipe_id null → intet link');
eq(link(sub({ recipe_id: 0 })), 'Æggesalat', 'recipe_id 0 → intet link');
eq(link({}), '', 'tomt objekt vælter ikke');
eq(link(null), '', 'null vælter ikke');

console.log('\nS3 · En mængde vi ikke kan stå inde for sendes ikke');
for (const v of [0, -1, null, undefined, 'abc', 0.0004]) {
    ok(!subHref(sub({ servings: v })).includes('portions'),
       `servings=${JSON.stringify(v)} sendes ikke — vieweren bruger opskriftens eget tal`,
       subHref(sub({ servings: v })));
}

console.log('\nS5 · Fane-valget afgøres ved klik-tid');
// Start med FORKERTE værdier, så asserterne måler hvad handleren sætter — ikke
// hvad markup'en tilfældigvis havde. `a` kan gives med, så en sekvens af klik
// på det SAMME element kan efterprøves (kiosk → ikke-kiosk).
function nav({ kiosk = false, fullscreen = false, a, label } = {}) {
    domCtx.document.body.classList._set = new Set(kiosk ? ['kiosk'] : []);
    domCtx.document.fullscreenElement = fullscreen ? {} : null;
    let stopped = false;
    const el = a || { target: 'IKKE-SAT', title: 'IKKE-SAT', href: '/x',
                      dataset: label ? { openLabel: label } : {} };
    _subRecipeNav({ stopPropagation() { stopped = true; } }, el);
    return { target: el.target, title: el.title, stopped, el };
}
eq(nav().target, '_blank', 'normalt: ny fane, så råvarelisten bliver stående');
eq(nav({ kiosk: true }).target, '_self',
   'kiosk: samme fane — en køkkentablet i fullscreen kan ikke lukke en ny fane');
eq(nav({ fullscreen: true }).target, '_self',
   'fullscreen uden kiosk-klassen tæller også — det er fanebjælken der mangler');
eq(nav({ kiosk: true }).title, 'Åbn opskriften',
   'tooltip lover ikke en ny fane når der ikke kommer en');
eq(nav().title, 'Åbn opskriften i ny fane', 'og lover den når der gør');
// Rækkefølgen betyder noget: forlader man kiosk, må tooltip'en ikke blive
// hængende og love en ny fane der ikke kommer — eller omvendt. Fanget i
// browseren, hvor et kiosk-klik efterlod "Åbn opskriften" på et _blank-link.
const genbrug = nav({ kiosk: true }).el;
eq(nav({ a: genbrug }).title, 'Åbn opskriften i ny fane',
   'samme element efter kiosk: tooltip følger med tilbage');
eq(nav({ a: genbrug }).target, '_blank', 'og target følger med tilbage');
eq(nav({ kiosk: true, a: genbrug }).title, 'Åbn opskriften',
   'og skifter igen når kiosk slås til');
// Kan-laves-links bærer opskriftens navn. Handleren må ikke overskrive det med
// en generisk tekst ved første klik — så ville navnet være tabt for altid.
eq(nav({ label: 'Åbn Langtids stegt Gris' }).title, 'Åbn Langtids stegt Gris i ny fane',
   'opskriftens navn overlever klikket');
eq(nav({ label: 'Åbn Langtids stegt Gris', kiosk: true }).title, 'Åbn Langtids stegt Gris',
   'også i kiosk, hvor "i ny fane" falder væk');
eq(nav({}).title, 'Åbn opskriften i ny fane',
   'uden etiket falder den tilbage til noget generisk, ikke tomt');
ok(nav().stopped, 'boblingen standses uanset fane-valg');
ok(nav({ kiosk: true }).stopped, 'også i kiosk');

console.log('\nS4 · Navnet escapes');
ok(!link(sub({ recipe_name: '<img src=x onerror=alert(1)>' })).includes('<img'),
   'et opskriftsnavn med markup kan ikke bryde ud');
ok(link(sub({ recipe_name: 'Løg & "salt"' })).includes('&amp;'),
   '& escapes i navnet', link(sub({ recipe_name: 'Løg & "salt"' })));

// ── Kan-laves-råvarer (samme modal, anden datasti) ──────────────────────────
const ing = (o) => Object.assign({
    product_name: 'Langtids Stegt Gris',
    make_recipe_id: 28, make_recipe_name: 'Langtids stegt Gris',
    make_batches: 2, make_status: 'ok',
}, o);
function mlink(x) { try { return _makeRecipeLink(x); } catch (e) { return `KASTEDE: ${e.message}`; } }
const mHref  = (x) => (mlink(x).match(/href="([^"]*)"/) || [, ''])[1];
const mLabel = (x) => (mlink(x).match(/data-open-label="([^"]*)"/) || [, ''])[1];

console.log('\nK1 · Produktnavnet linker til den opskrift der laver varen');
eq(mHref(ing({})), '/kitchen/recipes.html?recipe=28&batches=2',
   'make_recipe_id + make_batches — samme form som "Lav snart"');
ok(mlink(ing({})).includes('>Langtids Stegt Gris</a>'),
   'linkteksten er PRODUKTETS navn — det er rækkens emne');
eq(mLabel(ing({})), 'Åbn Langtids stegt Gris',
   'tooltip navngiver OPSKRIFTEN — de to hedder ikke det samme');
eq(mHref(ing({ make_status: 'mangler' })), '/kitchen/recipes.html?recipe=28&batches=2',
   'en blokeret råvare linker OGSÅ — dér ser man hvad der skal købes');

console.log('\nK2 · Kun varer der faktisk skal laves bliver links');
eq(mlink(ing({ make_recipe_id: null })), 'Langtids Stegt Gris',
   'en vare på hylden har intet make_recipe_id → ren tekst, ingen støj');
eq(mlink({ product_name: 'Æbler' }), 'Æbler', 'ren råvare røres ikke');
eq(mlink({}), '', 'tomt objekt vælter ikke');
eq(mlink(null), '', 'null vælter ikke');

console.log('\nK3 · Ukendt udbytte → intet batch-tal (samme regel som "Lav snart")');
eq(mHref(ing({ make_status: 'ukendt', make_batches: 1 })), '/kitchen/recipes.html?recipe=28',
   "make_status 'ukendt' sender ikke resolverens fallback videre");
eq(mLabel(ing({ make_recipe_name: null })), 'Åbn opskriften',
   'uden opskriftsnavn falder etiketten tilbage til noget sandt');
ok(!mlink(ing({ product_name: '<img src=x>' })).includes('<img'),
   'produktnavnet escapes');
ok(!mlink(ing({ make_recipe_name: '<b>ondt</b>' })).includes('<b>'),
   'opskriftsnavnet i tooltip escapes også');

console.log('\nR1 · Den fælles regel deles af alle tre — ikke tre kopier');
eq(recipeUrl({ recipeId: 5, portions: 2, batches: 9 }), '/kitchen/recipes.html?recipe=5&portions=2',
   'portions vinder over batches — den kræver ingen omregning');
eq(recipeUrl({ recipeId: 5, batches: 3 }), '/kitchen/recipes.html?recipe=5&batches=3',
   'batches bruges når portions mangler');
eq(recipeUrl({ recipeId: 5, batches: 3, trustBatches: false }), '/kitchen/recipes.html?recipe=5',
   'trustBatches:false → tallet er en fallback og sendes ikke');
eq(recipeUrl({ recipeId: 0, portions: 4 }), '', 'uden opskrift ingen URL');
eq(recipeUrl({}), '', 'tomt input vælter ikke');
eq(recipeUrl(), '', 'intet input vælter ikke');
// Dashboardet og kan-laves-rækken er to kaldere af samme regel: giv dem samme
// tal, og de skal producere nøjagtig samme URL.
eq(_paHref({ recipe_id: 28, batches: 2, make_status: 'ok' }), mHref(ing({})),
   '"Lav snart" og kan-laves-rækken bygger samme URL af samme tal');
eq(_paHref({ recipe_id: 28, batches: 1, make_status: 'ukendt' }),
   mHref(ing({ make_batches: 1, make_status: 'ukendt' })),
   'og er enige om at et fallback-tal ikke sendes');

console.log('\n─────────────────────────────────────────');
console.log(`${fail ? '\x1b[31m' : '\x1b[32m'}${pass} PASS\x1b[0m · ${fail ? '\x1b[31m' : ''}${fail} FAIL\x1b[0m`);
process.exit(fail ? 1 : 0);
