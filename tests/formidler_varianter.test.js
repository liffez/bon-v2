// tests/formidler_varianter.test.js
// ==========================================
// Rapportens variant-gruppering: hvornår er to slutkunde-navne den samme kunde?
//
// Fixturen er de navne der FAKTISK står i drift 18. september 2026. "Systematic"
// optrådte i fire skrivemåder, og kun tre blev grupperet — `Systematic A/S` stod
// som en selvstændig slutkunde, så listen sagde 5 hvor den skulle sige 6. Det er
// dét variant-tjekket findes for at fange, så fejlen er skrevet ind som fixture
// frem for som et konstrueret eksempel.
//
// Reglen har to lag, og de skal ikke blandes sammen:
//   1. formidlerens eget navn hængt bagpå ("/ able") er deres konvention
//   2. juridiske endelser og parenteser — samme normalizeName som matcheren
//      bruger til at afgøre om to firmanavne er samme firma
//
// En AFDELING er hverken af delene og må ikke grupperes: forskellen mellem
// "Per Aarsleff" og "Per Aarsleff – Kontor i Lyngby" kan være reel.
// ==========================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { normalizeName } = require(path.join(ROOT, 'services/companyMatcher'));

// Den ÆGTE kerne() fra rapporten — ikke en kopi.
const src = fs.readFileSync(path.join(ROOT, 'scripts/audit-formidler-slutkunder.js'), 'utf8');
const body = src.match(/function kerne\(navn, formidler\) \{[\s\S]*?\n\}/);
assert.ok(body, 'kerne() skal kunne findes i rapporten');
const kerne = new Function('normalizeName', body[0] + '; return kerne;')(normalizeName);

const grupper = (navne, formidler) => {
    const g = new Map();
    for (const n of navne) {
        const k = kerne(n, formidler);
        if (!g.has(k)) g.set(k, []);
        g.get(k).push(n);
    }
    return g;
};

test('de fire Systematic-skrivemåder fra drift er én slutkunde', () => {
    const navne = ['Systematic / able', 'Systematic', 'Systematic A/S', 'Systematic  (Able)'];
    const g = grupper(navne, 'Able');
    assert.strictEqual(g.size, 1, 'alle fire skal havne i samme gruppe:\n  ' +
        [...g.entries()].map(([k, v]) => k + ' ← ' + v.join(' | ')).join('\n  '));
    assert.strictEqual([...g.values()][0].length, 4);
});

test('formidlerens navn hængt bagpå fjernes — uanset skilletegn', () => {
    for (const n of ['Cisco / able', 'Cisco - able', 'Cisco (Able)', 'Cisco, able'])
        assert.strictEqual(kerne(n, 'Able'), kerne('Cisco', 'Able'), n + ' skal blive til Cisco');
});

test('afdelinger grupperes IKKE', () => {
    // "Kontor i Lyngby" kan være en reel skelnen — anden adresse, anden
    // afdeling. Det er et menneskes beslutning, ikke en normalisering.
    assert.notStrictEqual(
        kerne('Per Aarsleff – Kontor i Lyngby', 'Able'),
        kerne('Per Aarsleff', 'Able'));
});

test('forskellige kunder blandes ikke sammen', () => {
    // Kontrolprøven. En for ivrig normalisering ville slå ægte kunder sammen,
    // og så ville rapporten foreslå en oprydning der er forkert.
    const navne = ['Lundbeckfonden', 'Lundbeck', 'Dignity', 'Vega',
                   'Cisco', 'TBWA Copenhagen A/S', 'Worksome', 'Bigum'];
    const g = grupper(navne, 'Able');
    assert.strictEqual(g.size, navne.length,
        'hver af dem er sin egen slutkunde:\n  ' +
        [...g.entries()].filter(([, v]) => v.length > 1)
            .map(([k, v]) => k + ' ← ' + v.join(' | ')).join('\n  '));
});

test('formidleren midt i navnet røres ikke', () => {
    // Kun en HALE fjernes. "Able Consulting" som slutkunde er et rigtigt navn.
    assert.strictEqual(kerne('Able Consulting', 'Able'), normalizeName('Able Consulting'));
});

test('tomt og skævt input vælter ikke rapporten', () => {
    for (const n of [null, undefined, '', '   ', '/ able'])
        assert.doesNotThrow(() => kerne(n, 'Able'), 'kerne(' + JSON.stringify(n) + ')');
});

test('rapporten bruger companyMatcher, ikke sin egen normalisering', () => {
    // Skrevet af ville rapporten og matcheren kunne blive uenige om hvornår to
    // firmanavne er samme firma.
    assert.match(src, /require\('\.\.\/services\/companyMatcher'\)/,
        'rapporten skal importere normalizeName');
    assert.match(src, /return normalizeName\(s\);/,
        'kerne() skal slutte i normalizeName — ikke i sin egen tegn-strip');
});
