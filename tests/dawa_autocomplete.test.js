// tests/dawa_autocomplete.test.js
// ==========================================================================
// dawaAutocomplete(): adresseforslag med København først.
//
// DAWA rangerer ikke efter nærhed, og "Vesterbrogade 10, København V" er
// ikke blandt de første 30 hits på et ufiltreret opslag. Helperen spørger
// derfor to gange (hovedstadsområdet + alt) og fletter: lokale først, hver
// blok efter postnr, uden dubletter.
//
// Browserkode kan ikke require's, så den rigtige shared/utils.js køres i en
// vm-sandkasse med en fetch-attrap der svarer pr. URL. Bestillingssiden er
// single-file og bærer en KOPI af reglen — §3 asserterer at de to giver
// samme svar på samme input.
//
// Kør: node --test tests/dawa_autocomplete.test.js
// ==========================================================================

const test   = require('node:test');
const assert = require('node:assert');
const vm     = require('node:vm');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT = path.join(__dirname, '..');
const UTILS = fs.readFileSync(path.join(ROOT, 'shared', 'utils.js'), 'utf8');

/** Sandkassens arrays er fra en anden realm — kopiér til host før deepStrictEqual. */
function ids(list) { return Array.prototype.slice.call(list).map(x => x.adresse.id); }

function item(id, postnr, tekst) {
    return { tekst, adresse: { id, postnr: String(postnr), postnrnavn: 'By', vejnavn: 'Vej', husnr: '1' } };
}

/** fetch-attrap: `plan.local` / `plan.global` er enten et array eller en Error. */
function makeFetch(plan, calls) {
    return async function(url) {
        calls.push(url);
        const isLocal = url.includes('kommunekode=');
        const body = isLocal ? plan.local : plan.global;
        if (body instanceof Error) throw body;
        if (body === 'http500') return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => body };
    };
}

function loadUtils() {
    const sandbox = {
        console, setTimeout, clearTimeout, Promise, Error, JSON, Object, Array, String,
        Number, Boolean, Date, Math, RegExp, parseInt, isNaN, encodeURIComponent,
        window: {}, document: { addEventListener() {}, body: {} }, location: { href: '' },
        navigator: {}, localStorage: { getItem() { return null; }, setItem() {} },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(UTILS, sandbox, { filename: 'utils.js' });
    return sandbox;
}

/* ──────────────────────────────────────────────────────────────
   §1 Flette-reglen (ren funktion)
   ────────────────────────────────────────────────────────────── */

test('lokale hits først, hver blok sorteret efter postnr', () => {
    const U = loadUtils();
    const local  = [item('a', 2400, 'Frederiksborgvej 2'), item('b', 1360, 'Frederiksborggade 3')];
    const global = [item('c', 8800, 'Vesterbrogade 10, Viborg'), item('d', 3250, 'Vesterbrogade 10, Gilleleje'), item('e', 6000, 'Kolding')];
    const out = ids(U.dawaMergeSuggestions(local, global, 10));
    assert.deepStrictEqual(out, ['b', 'a', 'd', 'e', 'c']);
});

test('dubletter (samme adresse-id) vises kun én gang — og beholder den lokale plads', () => {
    const U = loadUtils();
    const kbh = item('x', 1620, 'Vesterbrogade 10, 1620 København V');
    const out = U.dawaMergeSuggestions([kbh], [item('c', 8800, 'Viborg'), kbh], 10);
    assert.deepStrictEqual(ids(out), ['x', 'c']);
});

test('limit klipper efter fletningen, ikke før — lokale fortrænger globale', () => {
    const U = loadUtils();
    const local = [1, 2, 3].map(i => item('l' + i, 2000 + i, 'L' + i));
    const global = [1, 2, 3].map(i => item('g' + i, 8000 + i, 'G' + i));
    assert.deepStrictEqual(ids(U.dawaMergeSuggestions(local, global, 4)), ['l1', 'l2', 'l3', 'g1']);
});

test('ukendt postnr sidst; samme postnr beholder DAWA\'s rækkefølge (stabil)', () => {
    const U = loadUtils();
    const list = [item('a', 2400, 'A'), item('b', '', 'B'), item('c', 2400, 'C'), item('d', 1000, 'D')];
    assert.deepStrictEqual(ids(U.dawaSortByPostnr(list)), ['d', 'a', 'c', 'b']);
});

test('item uden id og uden tekst springes over — ingen crash', () => {
    const U = loadUtils();
    const out = U.dawaMergeSuggestions([{ tekst: '', adresse: {} }], [item('c', 8800, 'V')], 5);
    assert.deepStrictEqual(ids(out), ['c']);
});

/* ──────────────────────────────────────────────────────────────
   §2 Forespørgslerne
   ────────────────────────────────────────────────────────────── */

test('spørger DAWA to gange: lokal med kommunekode (aldrig fuzzy), global med fuzzy når bedt', async () => {
    const U = loadUtils();
    const calls = [];
    const out = await U.dawaAutocomplete('Vesterbrogade 10', {
        fuzzy: true, limit: 7,
        fetch: makeFetch({ local: [item('x', 1620, 'Kbh')], global: [item('c', 8800, 'Viborg')] }, calls),
    });
    assert.strictEqual(calls.length, 2);
    const local = calls.find(u => u.includes('kommunekode='));
    const global = calls.find(u => !u.includes('kommunekode='));
    assert.ok(local.includes('kommunekode=0101%7C0147') || local.includes('kommunekode=0101|0147'), 'lokal filtrerer på København+Frederiksberg først: ' + local);
    assert.ok(!local.includes('fuzzy'), 'fuzzy + filter giver 0 hits hos DAWA — lokal må ikke være fuzzy');
    assert.ok(global.includes('fuzzy=true'), 'global får fuzzy når kalderen beder om det');
    assert.ok(local.includes('per_side=7') && global.includes('per_side=7'));
    assert.ok(local.includes('q=Vesterbrogade%2010'));
    assert.deepStrictEqual(ids(out), ['x', 'c']);
});

test('uden fuzzy-option er ingen af forespørgslerne fuzzy', async () => {
    const U = loadUtils();
    const calls = [];
    await U.dawaAutocomplete('Vester', { fetch: makeFetch({ local: [], global: [] }, calls) });
    assert.ok(calls.every(u => !u.includes('fuzzy')));
});

test('fejler den lokale forespørgsel, vises den globale alene', async () => {
    const U = loadUtils();
    const out = await U.dawaAutocomplete('Vester', {
        fetch: makeFetch({ local: new Error('net'), global: [item('c', 8800, 'Viborg'), item('d', 3250, 'Gilleleje')] }, []),
    });
    assert.deepStrictEqual(ids(out), ['d', 'c']);
});

test('lokal HTTP 500 behandles som tom — ikke som fejl', async () => {
    const U = loadUtils();
    const out = await U.dawaAutocomplete('Vester', { fetch: makeFetch({ local: 'http500', global: [item('c', 8800, 'V')] }, []) });
    assert.deepStrictEqual(ids(out), ['c']);
});

test('fejler den globale, kastes — som det gamle enkelt-fetch gjorde', async () => {
    const U = loadUtils();
    await assert.rejects(
        U.dawaAutocomplete('Vester', { fetch: makeFetch({ local: [item('x', 1620, 'Kbh')], global: new Error('net') }, []) }),
        /net/,
    );
});

test('svar der ikke er et array (DAWA-fejlobjekt) giver tom liste, ikke crash', async () => {
    const U = loadUtils();
    const out = await U.dawaAutocomplete('Vester', { fetch: makeFetch({ local: { type: 'QueryParameterFormatError' }, global: [] }, []) });
    assert.deepStrictEqual(Array.prototype.slice.call(out), []);
});

/* ──────────────────────────────────────────────────────────────
   §3 De offentlige siders kopier svarer det samme

   To standalone-sider bærer hver sin kopi af opslaget, fordi de ikke kan
   importere noget. Kopierne er et vilkår — at de driver fra hinanden er det
   ikke: så ville den ene side rangere adresserne anderledes end den anden,
   og ingen ville opdage det før en kunde ikke kunne finde sin vej.
   ────────────────────────────────────────────────────────────── */

const PUBLIC_DAWA_COPIES = [
    ['public', 'embed', 'bestilling.html'],
    ['booking', 'smagning.html'],
];

for (const parts of PUBLIC_DAWA_COPIES) {
  const rel = parts.join('/');
  test(rel + ' bærer samme flette-regel som utils.js', () => {
    const html = fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
    const src = html.split('<script>').slice(1).map(s => s.split('</script>')[0]).join('\n');
    // Kun de rene funktioner — resten af siden rører DOM ved load.
    const pick = (name) => {
        const m = src.match(new RegExp('(?:const|function) ' + name + '[\\s\\S]*?\\n}\\n'));
        assert.ok(m, 'fandt ikke ' + name + ' i ' + rel);
        return m[0];
    };
    const kom = src.match(/const DAWA_LOCAL_KOMMUNER = \[[\s\S]*?\];/);
    assert.ok(kom, 'DAWA_LOCAL_KOMMUNER mangler i ' + rel);
    const ctx = { parseInt, isNaN, Array, Object };
    vm.createContext(ctx);
    // `const` bindes ikke på sandkassens global — hent dem via scriptets slutværdi.
    const E = vm.runInContext(
        kom[0] + '\n' + pick('dawaSortByPostnr') + pick('dawaMergeSuggestions')
        + '\n;({ DAWA_LOCAL_KOMMUNER, dawaSortByPostnr, dawaMergeSuggestions })', ctx);
    const U = loadUtils();

    assert.deepStrictEqual([...E.DAWA_LOCAL_KOMMUNER], [...U.DAWA_LOCAL_KOMMUNER], 'kommunelisten er drevet fra hinanden');

    const local  = [item('a', 2400, 'A'), item('b', 1360, 'B'), item('dup', 1620, 'Dup')];
    const global = [item('c', 8800, 'C'), item('dup', 1620, 'Dup'), item('d', 3250, 'D'), item('e', '', 'E')];
    for (const limit of [3, 5, 10]) {
        assert.deepStrictEqual(
            ids(E.dawaMergeSuggestions(local, global, limit)),
            ids(U.dawaMergeSuggestions(local, global, limit)),
            'limit ' + limit,
        );
    }
  });
}
