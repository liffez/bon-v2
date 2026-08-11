// tests/changelog_render.test.js
// Smoke-test for changelog-rendereren i shared/modal.js
// Køres via:  node --test tests/changelog_render.test.js
//
// Baggrund: changelog bærer både menneske-ændringer og maskin-revisionsspor.
// `grocy_consume` lægger hele results-arrayet i new_value, og den generiske
// gren dumpede det råt — én entry på flere tusind tegn skjulte al anden
// historik. Testen holder fast i at maskin-payloads bliver opsummeret.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');
const vm     = require('node:vm');

// modal.js er et browser-script uden exports — kør det i en sandkasse med
// netop de globals den rører ved ved indlæsning.
const sandbox = {
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    parseServerDate: (s) => new Date(String(s).replace(' ', 'T')),
    BON_CONFIG: { statuses: {} },
    document: { addEventListener() {}, removeEventListener() {} },
    window: {},
    console,
};
vm.createContext(sandbox);
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'shared', 'modal.js'), 'utf8'),
    sandbox,
    { filename: 'shared/modal.js' }
);
const { _buildChangelogEntry, _parseConsumePayload } = sandbox;

const RESULTS = [
    { product_id: 43, product_name: 'Semidried Tomater', amount: 0.0134, partial: false, success: true },
    { product_id: 74, product_name: 'Små Burgerlommer', amount: 18,      partial: false, success: true },
    { product_id: 28, product_name: 'Spinat',           amount: 0,       partial: true,  success: true },
    { product_id: 1,  product_name: 'Brød Rug',         amount: 0,       success: false, error: 'stale stock' },
];

const consumeEntry = (newValue) => ({
    action: 'grocy_consume', field_name: 'stock',
    old_value: null, new_value: newValue, created_at: '2026-08-10 10:31:00',
});

test('grocy_consume: rå results-array læses', () => {
    const p = _parseConsumePayload(JSON.stringify(RESULTS));
    assert.strictEqual(p.kind, 'results');
    assert.strictEqual(p.results.length, 4);
});

test('grocy_consume: {state, results}-indpakning læses', () => {
    const p = _parseConsumePayload(JSON.stringify({ state: 'ok', results: RESULTS }));
    assert.strictEqual(p.kind, 'results');
    assert.strictEqual(p.results.length, 4);
});

test('grocy_consume: sentinel for event-prep genkendes', () => {
    assert.strictEqual(_parseConsumePayload('event_prep_owns_stock').kind, 'skipped');
});

test('grocy_consume: ukendt payload falder tilbage til rå tekst', () => {
    assert.strictEqual(_parseConsumePayload('noget-uventet').kind, 'raw');
});

test('grocy_consume opsummeres — ikke rå JSON i historikken', () => {
    const html = _buildChangelogEntry(consumeEntry(JSON.stringify({ state: 'ok', results: RESULTS })));

    assert.match(html, /Lagertræk/);
    assert.match(html, /3 varer trukket fra lager/);   // 4 i alt − 1 fejlet
    assert.match(html, /1 delvist/);
    assert.match(html, /1 fejlede/);
    assert.match(html, /Vis varer \(4\)/);
    // Selve JSON-nøglerne må ikke stå i outputtet
    assert.doesNotMatch(html, /shortfall|"success"|product_id/);
});

test('event-prep-sentinel vises som forklaring, ikke som kode', () => {
    const html = _buildChangelogEntry(consumeEntry('event_prep_owns_stock'));
    assert.match(html, /event-prep ejer HQ-lageret/);
    assert.doesNotMatch(html, /event_prep_owns_stock/);
});

test('ukendt maskin-payload i generisk gren afkortes', () => {
    const long = JSON.stringify(RESULTS).repeat(20);
    const html = _buildChangelogEntry({
        action: 'update', field_name: 'mystery', new_value: long, created_at: '2026-08-10 09:00:00',
    });
    assert.ok(html.length < 1500, `forventede afkortet output, fik ${html.length} tegn`);
    assert.match(html, /…/);
});

test('notes vises — booking-entries har kun rå id i new_value', () => {
    const html = _buildChangelogEntry({
        action: 'update', field_name: 'delivery_vehicle_id',
        old_value: null, new_value: '7',
        notes: 'Bestilt hos Taxa 4x35 (ref: AB12)',
        created_at: '2026-08-10 09:00:00',
    });
    assert.match(html, /Køretøj/);
    assert.match(html, /Bestilt hos Taxa 4x35/);
});

test('notes duplikeres ikke når den er identisk med new_value', () => {
    const html = _buildChangelogEntry({
        action: 'update', field_name: 'kitchen_info',
        old_value: null, new_value: 'Husk allergi', notes: 'Husk allergi',
        created_at: '2026-08-10 09:00:00',
    });
    assert.strictEqual(html.match(/Husk allergi/g).length, 1);
});

test('almindelige entries er uændrede', () => {
    const created = _buildChangelogEntry({ action: 'create', created_at: '2026-08-10 08:00:00' });
    assert.match(created, /Oprettet/);
    assert.match(created, /Bon oprettet/);

    const status = _buildChangelogEntry({
        action: 'status_change', field_name: 'status',
        old_value: 'KLAR', new_value: 'LEVERET', created_at: '2026-08-10 10:30:00',
    });
    assert.match(status, /Statusskift/);
    assert.match(status, /LEVERET/);
});
