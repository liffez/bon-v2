#!/usr/bin/env node
'use strict';
/**
 * scripts/test-fakturering-render.js
 * ────────────────────────────────────────────────────────────
 * Renderer fakturerings-viewets rene HTML-byggere i en vm-sandkasse.
 *
 * Browser-kode kan ikke require's, så filen køres med stubbede globals og
 * funktionerne kaldes DIREKTE — det er de samme funktioner browseren bruger,
 * ikke en kopi (samme mønster som scripts/test-recipe-viewer-nested.js).
 *
 * Dækker det unit- og integrationstestene ikke kan se: at skabelonerne
 * overhovedet producerer HTML, og at forhåndsvisning og prøvekørsel viser
 * det SAMME — de deler _faktPayloadHtml, og det skal de blive ved med.
 *
 * Kør: node scripts/test-fakturering-render.js
 * ────────────────────────────────────────────────────────────
 */
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

let pass = 0, fail = 0;
const ok = (navn, cond, ekstra = '') => {
    if (cond) { pass++; console.log(`  ✓ ${navn}`); }
    else { fail++; console.error(`  ✗ ${navn} ${ekstra}`); }
};

const kilde = fs.readFileSync(path.join(__dirname, '..', 'office', 'views', 'fakturering.js'), 'utf8');
const sandbox = {
    console, document: {
        // Elementer huskes pr. id, så en test kan se hvad der blev renderet i dem.
        _els: new Map(),
        getElementById(id) {
            if (!this._els.has(id)) this._els.set(id, { id, innerHTML: '', style: {}, classList: { add(){}, remove(){} } });
            return this._els.get(id);
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({ style: {}, classList: { add(){}, remove(){} } }),
    },
    window: { Moms: {
        exclToIncl: (n) => n * 1.25,
        inclToExcl: (n) => n / 1.25,
        // Samme form som shared/moms.js — §6b: input er INCL moms.
        computeMomsFields: (incl) => {
            const i = Math.round((incl || 0) * 100) / 100;
            const e = Math.round((i / 1.25) * 100) / 100;
            return { total_incl_moms: i, total_excl_moms: e, moms_amount: Math.round((i - e) * 100) / 100 };
        },
    } },
    // Bonlinje-sammenlægningen er testet for sig (shared/bon_lines.js) — her skal
    // den bare ikke stå i vejen for at skabelonen kan renderes.
    BonLines: { mergeLines: (lines) => lines },
    setTimeout, clearTimeout, fetch: async () => ({ ok: true, json: async () => ({}) }),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(kilde, sandbox, { filename: 'fakturering.js' });

const PAYLOAD = {
    date: '2026-08-18', recipient: { name: 'CAP PARTNER ApS' }, customer: { customerNumber: 944 },
    references: { other: 'B4175' }, delivery: { deliveryDate: '2026-08-18' },
    lines: [
        { lineNumber: 1, product: { productNumber: '65' }, description: 'Kartoflen', quantity: 2, unitNetPrice: 75.20 },
        { lineNumber: 2, product: { productNumber: '111' }, description: 'Fingergrønt', quantity: 1, unitNetPrice: 860 },
    ],
};
const READINESS = {
    ok: false, missingCustomer: false, eanWithoutContact: false, missingDelivery: false,
    oneoffAvailable: true,
    missingProducts: [{ line_id: 9, product_name: 'Fingergrønt', grocy_recipe_id: null, amount: 1075, reason: 'no_product' }],
    excluded: [{ line_id: 8, product_name: 'RR Boks  (emballage)', grocy_recipe_id: 45, amount: 0, reason: 'noninvoice' }],
    excluded_total: 0,
};

console.log('\n── Payload-tabellen ──');
const h = sandbox._faktPayloadHtml(PAYLOAD, READINESS);
ok('#1 rendrer uden at kaste', typeof h === 'string' && h.length > 200);
ok('#1 begge linjer med', h.includes('Kartoflen') && h.includes('Fingergrønt'));
ok('#1 varenumrene vises', h.includes('>65<') && h.includes('>111<'));
ok('#1 ingen uopløste skabeloner', !/\$\{/.test(h), h.slice(0, 120));
ok('#1 modtager + kunde-nr', h.includes('CAP PARTNER ApS') && h.includes('944'));
// ex 150,40 + 860 = 1.010,40 → incl 1.263. _faktFmt runder til hele kroner
// (husets visningskonvention i faktureringen) — payloaden bærer de præcise tal.
ok('#1 summen er ex moms, totalen incl', h.includes('1.010') && h.includes('1.263'), h.match(/[\d.,]+ kr/g)?.join(' '));
ok('#1 udeladte linjer hænger på', h.includes('RR Boks') && h.includes('faktureres ikke'));

const hNote = sandbox._faktPayloadHtml(PAYLOAD, READINESS, 'Prøvekørsel — der er ikke oprettet noget i e-conomic.');
ok('#2 prøvekørslen kan sætte sin egen note', hNote.includes('ikke oprettet noget i e-conomic'));
ok('#2 og viser ellers NØJAGTIG det samme som forhåndsvisningen',
    hNote.replace(/<p class="fakt-eco-pv-note">.*?<\/p>/s, '') === h.replace(/<p class="fakt-eco-pv-note">.*?<\/p>/s, ''));

console.log('\n── Blokerings-panelet ──');
const r = sandbox._faktReadinessHtml(READINESS, 42);
ok('#3 navngiver den blokerende linje', r.includes('Fingergrønt'));
ok('#3 viser beløbet', r.includes('1.075'), r.match(/[\d.,]+ kr/g)?.join(' '));
ok('#3 tilbyder engangsbeløb + prøvekørsel',
    r.includes('Fakturér som engangsbeløb') && r.includes('Prøvekørsel'));
ok('#3 forklarer at fritekst kun kan faktureres sådan', r.includes('fritekst uden opskrift'));
ok('#3 ingen uopløste skabeloner', !/\$\{/.test(r));

const rSelvmodsigelse = sandbox._faktReadinessHtml(
    { ...READINESS, missingProducts: [{ product_name: 'RR Boks', grocy_recipe_id: 45, amount: 25, reason: 'noninvoice_but_priced' }] }, 42);
ok('#4 selvmodsigelsen forklares', rSelvmodsigelse.includes('faktureres ikke') && rSelvmodsigelse.includes('men har en pris'));

const rUdenOneoff = sandbox._faktReadinessHtml({ ...READINESS, oneoffAvailable: false }, 42);
ok('#5 ingen knap når engangsvaren ikke er sat', !rUdenOneoff.includes('Fakturér som engangsbeløb'));
ok('#5 men det siges hvorfor', rUdenOneoff.includes('economic_oneoff_product_number'));

const rKundeMangler = sandbox._faktReadinessHtml({ ...READINESS, missingCustomer: true }, 42);
ok('#6 ingen engangsbeløb når KUNDEN mangler (den hjælper ikke der)',
    !rKundeMangler.includes('Fakturér som engangsbeløb'));

console.log('\n── Kontakt-nummeret er synligt på BEGGE slags bons ──');
// Fejlen fra drift: en privat bon bar et kontakt-nummer der lå under en anden
// e-conomic-kunde. Payloaden brugte det (economicInvoice.js), men panelet viste
// kun feltet for firma-bons — så det kunne hverken ses eller ryddes.
const BON_BASE = {
    id: 42, bon_number: 'B4244', delivery_date: '2026-09-10', pax: 14,
    total_price: 1797, delivery_price: 400, payment_type: 'faktura',
    status_code: 'LEVERET', lines: [{ product_name: 'Sandwich', quantity: 14, unit: 'stk', unit_price: 99.79, line_total: 1397 }],
};
const els = sandbox.document._els;

els.clear();
sandbox._faktSelectBon({ ...BON_BASE,
    customer: { id: 3860, first_name: 'Sophie', last_name: 'Schiøtt',
                economic_customer_id: '1030', economic_contact_id: '875' },
    company: null });
const privatHtml = els.get('fakt-detail-panel')?.innerHTML || '';
ok('#7 privat bon har en kontakt-række', privatHtml.includes('id="fakt-eco-privat-kontakt"'));
ok('#7 og kundenummer-rækken er der stadig', privatHtml.includes('id="fakt-eco-privat"'));
ok('#7 kontakt-nummeret vises med en rediger-knap',
    (els.get('fakt-eco-privat-kontakt')?.innerHTML || '').includes('875'),
    els.get('fakt-eco-privat-kontakt')?.innerHTML);
ok('#7 og det kan RYDDES herfra (ellers var fejlen ikke til at rette)',
    (els.get('fakt-eco-privat-kontakt')?.innerHTML || '').includes("'kontakt'"));

els.clear();
sandbox._faktSelectBon({ ...BON_BASE,
    customer: { id: 3860, first_name: 'Sophie', last_name: 'Schiøtt', economic_contact_id: '875' },
    company: { id: 3341, name: 'Høje-Taastrup Kommune', economic_customer_id: '1029' } });
const firmaHtml = els.get('fakt-detail-panel')?.innerHTML || '';
ok('#7 firma-bon har stadig sin kontakt-række', firmaHtml.includes('id="fakt-eco-kontakt"'));
ok('#7 firma-bon har IKKE privat-felterne', !firmaHtml.includes('id="fakt-eco-privat"'));

console.log('\n── e-conomics afvisning gøres læselig ──');
const E04800 = String.raw`e-conomic 400: {"message":"Validation failed. 1 error found.","errorCode":"E04300","httpStatusCode":400,"errors":{"customerContact":{"errors":[{"propertyName":"customerContact","errorMessage":"Mismatching customer number for invoice and customer contact","errorCode":"E04800","inputValue":875,"developerHint":"Invoice customer: 1029, customer contact: 875, customer contact reference: 708"}]}},"errorCount":1}`;
const laest = sandbox._faktEcoReadableDetail(E04800);
ok('#8 overskriften kommer med', laest.includes('Validation failed'));
ok('#8 selve fejlen kommer med', laest.includes('Mismatching customer number'));
ok('#8 og hintet med numrene', laest.includes('Invoice customer: 1029'));
ok('#8 ingen rå JSON tilbage', !laest.includes('"errorCode"'));
ok('#8 en ikke-JSON besked vises som den er',
    sandbox._faktEcoReadableDetail('e-conomic timeout efter 20000 ms') === 'e-conomic timeout efter 20000 ms');
ok('#8 tom detail vælter ikke', sandbox._faktEcoReadableDetail(undefined) === '');

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
