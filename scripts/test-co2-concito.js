// scripts/test-co2-concito.js
// ============================================================
// Unit-test for CO₂ F4 — CONCITO/Katrine-import-logik (services/co2Concito.js).
// Ren logik, ingen Grocy — tester CSV-parse, kildehierarki-resolution,
// navne-fuzzy, produkt-match og diff-plan (inkl. idempotens).
//
// Kør:  node scripts/test-co2-concito.js
// ============================================================

'use strict';

const assert = require('assert');
const C = require('../services/co2Concito');

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); console.log('  ✓', name); pass++; }
    catch (e) { console.log('  ✗', name, '\n     →', e.message); fail++; }
}

console.log('CO₂ F4 — CONCITO/Katrine-import');

/* 1. parseCsv */
const CSV = [
    'ingrediens,status,oekologisk,horkram_varenr,klima_id,klima_kg,horkram_kg,noter',
    'Spinat,5,Ja,16991002,Ra00161,0.4825,0.43,',
    'Vand,5,Nej,,Ra00500,0,,',
    'Pebberkorn - Hele,2,Nej,,Ra00302,5.19,,',
    'Ukendtvare,2,Nej,,,,,ingen faktor',
    '"Navn, med komma",2,Nej,,Ra00999,1.5,,',
].join('\n');

t('parseCsv læser rækker + citat med komma', () => {
    const rows = C.parseCsv(CSV);
    assert.strictEqual(rows.length, 5);
    assert.strictEqual(rows[0].ingrediens, 'Spinat');
    assert.strictEqual(rows[4].ingrediens, 'Navn, med komma');
});

/* 2. resolveFields — kildehierarki §1 */
t('klima-faktor → source=klimadb + Ra-ID + version', () => {
    const r = C.resolveFields({ klima_id: 'Ra00161', klima_kg: '0.4825', horkram_kg: '0.43' });
    assert.strictEqual(r.source, 'klimadb');
    assert.strictEqual(r.fields.co2e_per_kg, '0.4825');
    assert.strictEqual(r.fields.co2e_klima_id, 'Ra00161');
    assert.strictEqual(r.fields.co2e_version, C.KLIMA_VERSION);
});
t('vand klima=0 er en gyldig faktor (ikke null)', () => {
    const r = C.resolveFields({ klima_id: 'Ra00500', klima_kg: '0', horkram_kg: '' });
    assert.ok(r);
    assert.strictEqual(r.fields.co2e_per_kg, '0');
    assert.strictEqual(r.source, 'klimadb');
});
t('kun Hørkram-faktor → source=supplier (Ra-ID bevares)', () => {
    const r = C.resolveFields({ klima_id: 'Ra00042', klima_kg: '', horkram_kg: '2.31' });
    assert.strictEqual(r.source, 'supplier');
    assert.strictEqual(r.fields.co2e_per_kg, '2.31');
    assert.strictEqual(r.fields.co2e_klima_id, 'Ra00042');
});
t('ingen faktor → null', () => {
    assert.strictEqual(C.resolveFields({ klima_kg: '', horkram_kg: '' }), null);
});
t('faktor > 40 flages suspicious', () => {
    const r = C.resolveFields({ klima_kg: '211', horkram_kg: '' });
    assert.ok(r.suspicious);
});
t('dansk decimalkomma i faktor', () => {
    const r = C.resolveFields({ klima_kg: '1,5', horkram_kg: '' });
    assert.strictEqual(r.fields.co2e_per_kg, '1.5');
});

/* 3. navne-fuzzy */
t('dice: identisk = 1', () => assert.strictEqual(C.dice('Spinat', 'spinat'), 1));
t('dice: tæt match høj score', () => assert.ok(C.dice('Rødløg - Rå', 'Rødløg rå') > 0.6));
t('dice: urelateret lav score', () => assert.ok(C.dice('Spinat', 'Chokolade') < 0.3));
t('normName bevarer æøå, fjerner tegn', () => assert.strictEqual(C.normName('Rødkål - Rå!'), 'rødkål rå'));

/* 4. matchProduct */
const PRODUCTS = [
    { id: 10, name: 'Spinat', userfields: {} },
    { id: 11, name: 'Rødløg Rå', userfields: {} },
    { id: 12, name: 'Chokolade Knapper', userfields: {} },
];
const BARCODES = new Map([['16991002', 10]]);

t('match via varenr (barcode) → score 1', () => {
    const m = C.matchProduct({ ingrediens: 'noget helt andet', horkram_varenr: '16991002' }, PRODUCTS, BARCODES);
    assert.strictEqual(m.via, 'varenr');
    assert.strictEqual(m.product.id, 10);
});
t('match via navn-fuzzy når varenr mangler', () => {
    const m = C.matchProduct({ ingrediens: 'Rødløg - Rå', horkram_varenr: '' }, PRODUCTS, BARCODES);
    assert.strictEqual(m.via, 'navn');
    assert.strictEqual(m.product.id, 11);
});
t('intet match → via none, product null', () => {
    const m = C.matchProduct({ ingrediens: 'Enhjørningekød', horkram_varenr: '' }, PRODUCTS, BARCODES);
    assert.strictEqual(m.via, 'none');
    assert.strictEqual(m.product, null);
});
t('manuel alias: "Gris" → Svinekam (via alias)', () => {
    const prods = [{ id: 50, name: 'Svinekam', userfields: {} }];
    const m = C.matchProduct({ ingrediens: 'Gris', horkram_varenr: '' }, prods, new Map());
    assert.strictEqual(m.via, 'alias');
    assert.strictEqual(m.product.id, 50);
});

/* 5. buildPlan — actions + idempotens */
t('buildPlan: write / no_factor / unmatched', () => {
    const rows = [
        { ingrediens: 'Spinat', horkram_varenr: '16991002', klima_id: 'Ra00161', klima_kg: '0.48', horkram_kg: '' }, // write (via varenr)
        { ingrediens: 'Chokolade Knapper', horkram_varenr: '', klima_id: '', klima_kg: '', horkram_kg: '' },          // no_factor (matcher navn, ingen faktor)
        { ingrediens: 'Enhjørningekød', horkram_varenr: '', klima_id: '', klima_kg: '9', horkram_kg: '' },            // unmatched (har faktor, intet produkt)
    ];
    const { summary } = C.buildPlan(rows, PRODUCTS, BARCODES);
    assert.strictEqual(summary.write, 1);
    assert.strictEqual(summary.no_factor, 1);
    assert.strictEqual(summary.unmatched, 1);
    assert.strictEqual(summary.via_varenr, 1);
});
t('buildPlan: uændret række (userfields matcher allerede) → unchanged', () => {
    const prods = [{ id: 10, name: 'Spinat',
        userfields: { co2e_per_kg: '0.48', co2e_source: 'klimadb', co2e_klima_id: 'Ra00161' } }];
    const rows = [{ ingrediens: 'Spinat', horkram_varenr: '16991002', klima_id: 'Ra00161', klima_kg: '0.48', horkram_kg: '' }];
    const { summary } = C.buildPlan(rows, prods, new Map([['16991002', 10]]));
    assert.strictEqual(summary.unchanged, 1);
    assert.strictEqual(summary.write, 0);
});

/* 6. kollision — samme produkt fra flere rækker */
t('kollision, forskellig faktor → begge conflict (skriver ikke)', () => {
    // "Mayonaise" + "honning" har (fejlagtigt) samme varenr → samme produkt, forskellig faktor
    const prods = [{ id: 47, name: 'Mayonaise', userfields: {} }];
    const bc = new Map([['60105401', 47]]);
    const rows = [
        { ingrediens: 'Mayonaise', horkram_varenr: '60105401', klima_id: 'Ra00202', klima_kg: '3.13', horkram_kg: '' },
        { ingrediens: 'honning',   horkram_varenr: '60105401', klima_id: 'Ra00380', klima_kg: '0.81', horkram_kg: '' },
    ];
    const { summary } = C.buildPlan(rows, prods, bc);
    assert.strictEqual(summary.conflict, 2);
    assert.strictEqual(summary.write, 0);
});
t('kollision, samme faktor → dedupér (1 write, 1 duplicate)', () => {
    // "Rødløg - Rå" + "Rødløg - Sylt" → samme produkt, SAMME faktor
    const prods = [{ id: 26, name: 'Rødløg - Rå', userfields: {} }];
    const bc = new Map([['16766976', 26], ['16766977', 26]]);
    const rows = [
        { ingrediens: 'Rødløg - Rå',   horkram_varenr: '16766976', klima_id: 'Ra00485', klima_kg: '0.81', horkram_kg: '' },
        { ingrediens: 'Rødløg - Sylt', horkram_varenr: '16766977', klima_id: 'Ra00485', klima_kg: '0.81', horkram_kg: '' },
    ];
    const { summary } = C.buildPlan(rows, prods, bc);
    assert.strictEqual(summary.write, 1);
    assert.strictEqual(summary.duplicate, 1);
    assert.strictEqual(summary.conflict, 0);
});

t('kollision, nær-dublet faktor (<2%) → dedupér, ikke conflict', () => {
    const prods = [{ id: 137, name: 'Hvidløg - i tern', userfields: {} }];
    const bc = new Map([['15820433', 137]]);
    const rows = [
        { ingrediens: 'Hvidløg - i tern', horkram_varenr: '15820433', klima_id: 'Ra00136', klima_kg: '1.2476', horkram_kg: '' },
        { ingrediens: 'Hvidløg',          horkram_varenr: '',          klima_id: 'Ra00136', klima_kg: '1.25',   horkram_kg: '' },
    ];
    const { summary } = C.buildPlan(rows, prods, bc);
    assert.strictEqual(summary.conflict, 0);
    assert.strictEqual(summary.write, 1);
    assert.strictEqual(summary.duplicate, 1);
});

/* 7. manuel udeluk-liste */
t('manuel udeluk: "Frikadeller" (hakkebøf) → excluded, skrives ikke', () => {
    const prods = [{ id: 7, name: 'Frikadeller', userfields: {} }];
    const rows = [{ ingrediens: 'Frikadeller', horkram_varenr: '', klima_id: 'Ra00391', klima_kg: '3.61', horkram_kg: '' }];
    const { summary } = C.buildPlan(rows, prods, new Map());
    assert.strictEqual(summary.excluded, 1);
    assert.strictEqual(summary.write, 0);
});

/* 8. synonym-grupper (dublet-varer deler faktor) */
t('buildSynonymMap: Hvidkål ↔ kål', () => {
    const prods = [{ id: 67, name: 'Hvidkål' }, { id: 199, name: 'kål' }, { id: 1, name: 'Andet' }];
    const m = C.buildSynonymMap(prods);
    assert.deepStrictEqual(m.get('67'), [199]);
    assert.deepStrictEqual(m.get('199'), [67]);
    assert.strictEqual(m.get('1'), undefined);
});
t('buildPlan: write til Hvidkål bærer also=[kål-id]', () => {
    const prods = [
        { id: 67, name: 'Hvidkål', userfields: {} },
        { id: 199, name: 'kål', userfields: {} },
    ];
    const syn = C.buildSynonymMap(prods);
    const rows = [{ ingrediens: 'kål', horkram_varenr: '15284730', klima_id: 'Ra00157', klima_kg: '0.287', horkram_kg: '' }];
    const bc = new Map([['15284730', 67]]); // Katrines "kål" → Hvidkål via varenr
    const { entries, summary } = C.buildPlan(rows, prods, bc, syn);
    assert.strictEqual(entries[0].action, 'write');
    assert.strictEqual(entries[0].match.product.id, 67);
    assert.deepStrictEqual(entries[0].also, [199]);   // faktoren skrives også til "kål"
    assert.strictEqual(summary.synonym_writes, 1);
});

console.log(`\n${pass} PASS · ${fail} FAIL`);
process.exit(fail ? 1 : 0);
