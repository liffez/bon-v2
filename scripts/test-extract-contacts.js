#!/usr/bin/env node
/**
 * scripts/test-extract-contacts.js — Tester services/contactExtractor.js
 * og POST /api/companies/:id/extract-contacts.
 *
 * Brug: node --experimental-sqlite scripts/test-extract-contacts.js
 */

const path = require('path');
try {
    const fs = require('fs');
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of lines) {
            const m = line.match(/^([^#=]+)=(.*)$/);
            if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
        }
    }
} catch {}

const { extractContacts, classifyEmail, normalizePhone } = require('../services/contactExtractor');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
    if (cond) { console.log(`  ✓ ${label}`); pass++; }
    else { console.log(`  ✗ ${label}` + (extra ? ` — ${extra}` : '')); fail++; }
}

console.log('=== Test 1: classifyEmail ===');
ok('info@regionh.dk → public', classifyEmail('info@regionh.dk') === 'public');
ok('kontakt@firma.dk → public', classifyEmail('kontakt@firma.dk') === 'public');
ok('presse@regionh.dk → public', classifyEmail('presse@regionh.dk') === 'public');
ok('faktura@regionh.dk → public', classifyEmail('faktura@regionh.dk') === 'public');
ok('lars.hansen@regionh.dk → personal', classifyEmail('lars.hansen@regionh.dk') === 'personal');
ok('m.jensen@firma.dk → personal', classifyEmail('m.jensen@firma.dk') === 'personal');
ok('tilbud@firma.dk → unknown', classifyEmail('tilbud@firma.dk') === 'unknown');

console.log('');
console.log('=== Test 2: normalizePhone ===');
ok('"38 66 60 00" → "38 66 60 00"', normalizePhone('38 66 60 00') === '38 66 60 00');
ok('"38666000" → "38 66 60 00"', normalizePhone('38666000') === '38 66 60 00');
ok('"+45 38666000" → "+45 38 66 60 00"', normalizePhone('+45 38666000') === '+45 38 66 60 00');

console.log('');
console.log('=== Test 3: extractContacts på simpel HTML ===');
const html = `
<html><body>
<div class="footer">
    <p>Pressehenvendelser: <a href="mailto:presse@regionh.dk">presse@regionh.dk</a></p>
    <p>Generel kontakt: info@regionh.dk eller på telefon 38 66 60 00.</p>
    <p>Patientvejledning: 35 45 35 45</p>
    <p>Overlæge Lars Hansen: lars.hansen@regionh.dk</p>
    <p>Afd. leder: mette.jensen@regionh.dk (har orlov)</p>
    <p>CVR: 29190623</p>
</div>
</body></html>
`;
const r = extractContacts({ text: html, sourceUrl: 'https://regionh.dk/kontakt' });
ok('ok=true', r.ok === true);
ok('source_url propagated', r.source_url === 'https://regionh.dk/kontakt');
ok('emails fundet', r.stats.total_emails_found === 4, `fik ${r.stats.total_emails_found}`);
ok('telefoner fundet (CVR ekskluderet)', r.stats.total_phones_found === 2, `fik ${r.stats.total_phones_found}`);

const presse = r.candidates.find(c => c.value === 'presse@regionh.dk');
ok('presse@ er public', presse?.classification === 'public');
ok('presse@ proposed_is_public=1', presse?.proposed_is_public === 1);

const info = r.candidates.find(c => c.value === 'info@regionh.dk');
ok('info@ er public', info?.classification === 'public');
ok('info@ har context_snippet', !!info?.context_snippet);

const lars = r.candidates.find(c => c.value === 'lars.hansen@regionh.dk');
ok('lars.hansen@ er personal', lars?.classification === 'personal');
ok('lars.hansen@ proposed_is_public=0', lars?.proposed_is_public === 0);

const phone1 = r.candidates.find(c => c.kind === 'phone' && c.value.includes('38'));
ok('hovednummer 38 66 60 00 fundet', !!phone1);
ok('telefon klassificeret unknown', phone1?.classification === 'unknown');

console.log('');
console.log('=== Test 4: CVR-mønster ekskluderes ===');
const r2 = extractContacts({ text: 'CVR 12345678 og DVR 12345678. ' + 'a'.repeat(50) });
const cvrPhones = r2.candidates.filter(c => c.kind === 'phone' && c.value.includes('1234'));
ok('CVR-tal IKKE inkluderet som telefon', cvrPhones.length === 0, `fandt ${cvrPhones.length}`);

console.log('');
console.log('=== Test 5: Obfuskeret @ ===');
const r3 = extractContacts({ text: 'Skriv til info(at)example.com eller info [at] firma.dk for kontakt. ' + 'x'.repeat(50) });
ok('info(at)example.com parses', r3.candidates.some(c => c.value === 'info@example.com'));
ok('info [at] firma.dk parses', r3.candidates.some(c => c.value === 'info@firma.dk'));

console.log('');
console.log('=== Test 6: Dedup på samme email i flere placeringer ===');
const r4 = extractContacts({ text: 'Email: info@x.dk. Igen: info@x.dk. ' + 'y'.repeat(50) });
const infoX = r4.candidates.filter(c => c.value === 'info@x.dk');
ok('dedupe', infoX.length === 1);

console.log('');
console.log('=== Test 7: Endpoint via mock ===');
const { getDb } = require('../db/database');
const db = getDb();

function mockReq(params, body) {
    return { params, body, query: {}, session: { user: { id: 1 } } };
}
function mockRes() {
    const r = { _status: 200, _body: null };
    r.status = (s) => { r._status = s; return r; };
    r.json = (b) => { r._body = b; return r; };
    return r;
}
function getHandler(router, method, p) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === p && layer.route.methods[method]) {
            return layer.route.stack[layer.route.stack.length - 1].handle;
        }
    }
    throw new Error(`Handler ikke fundet: ${method} ${p}`);
}

const router = require('../routes/companies');
const handler = getHandler(router, 'post', '/:id/extract-contacts');

(async () => {
    // Find et eksisterende firma
    const company = db.prepare("SELECT id FROM companies WHERE is_active=1 ORDER BY id LIMIT 1").get();

    // Test: for kort tekst
    const res1 = mockRes();
    await handler(mockReq({ id: String(company.id) }, { text: 'kort' }), res1);
    ok('400 ved for kort tekst', res1._status === 400);

    // Test: gyldigt input
    const res2 = mockRes();
    await handler(mockReq({ id: String(company.id) }, { text: html, source_url: 'https://test.dk/' }), res2);
    ok('200 ved gyldigt input', res2._status === 200);
    ok('candidates returneret', Array.isArray(res2._body.candidates));
    ok('stats indeholdt', !!res2._body.stats);

    // Test: ikke-eksisterende firma
    const res3 = mockRes();
    await handler(mockReq({ id: '999999' }, { text: html }), res3);
    ok('404 ved ukendt firma', res3._status === 404);

    console.log('');
    console.log('═══════════════════════════════════════');
    console.log(`  ${pass} passed, ${fail} failed`);
    console.log('═══════════════════════════════════════');
    process.exit(fail > 0 ? 1 : 0);
})().catch(err => {
    console.error('Fatal:', err);
    process.exit(2);
});
