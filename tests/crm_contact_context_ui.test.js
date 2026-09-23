// tests/crm_contact_context_ui.test.js
// ============================================================
// shared/crm_contact_context.js — kontaktlinjen og historikken der deles af
// service-kald, ringelisten og kampagne-tavlen. Den ÆGTE fil køres i en
// vm-sandkasse (browser-kode kan ikke require's).
// Kør: node --test tests/crm_contact_context_ui.test.js
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load(fetchStubs = {}) {
    const ctx = {
        console, Promise, Date, String, Math, Number, JSON,
        document: { head: { appendChild() {} }, createElement: () => ({}) },
        escapeHtml: (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        parseServerDate: (s) => new Date(String(s).replace(' ', 'T') + 'Z'),
        fetchCrmCustomerActivities: fetchStubs.acts || (async () => []),
        fetchCrmCustomerOrders: fetchStubs.orders || (async () => []),
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared', 'crm_contact_context.js'), 'utf8'), ctx);
    return ctx.CrmContactContext;
}

const base = {
    last_sentiment: null, colleague_sentiment: null, activity_count: 0, colleague_activity_count: 0,
    distance_km: null,
};

test('egen stemning vises med label og dato', () => {
    const C = load();
    const h = C.lineHtml({ ...base, last_sentiment: 'positive', last_sentiment_at: '2026-03-10 09:00:00' });
    assert.match(h, /😊 God · 10\/3/);
});

test('kollegaens stemning vises med navn — aldrig som kundens egen', () => {
    const C = load();
    const h = C.lineHtml({ ...base, colleague_sentiment: 'negative', colleague_sentiment_by: 'Bo <B>',
        colleague_sentiment_at: '2026-08-20 09:00:00' });
    assert.match(h, /colleague/);
    assert.match(h, /Bo &lt;B&gt;/, 'navnet escapes');
    assert.doesNotMatch(h, /Bo <B>/);
});

test('ingen kontakt siger det, og nævner kollegerne', () => {
    const C = load();
    const h = C.lineHtml({ ...base, colleague_activity_count: 3 });
    assert.match(h, /Ingen tidligere kontakt · 3 med kolleger/);
});

test('afstand: vejafstand uden "ca.", skøn med', () => {
    const C = load();
    assert.match(C.lineHtml({ ...base, distance_km: 3.456, delivery_postal_code: '2200', delivery_city: 'Kbh N' }), /🚗 3,5 km · 2200 Kbh N/);
    assert.match(C.lineHtml({ ...base, distance_km: 39.2, distance_estimated: true }), /🚗 ca\. 39 km/);
    assert.match(C.lineHtml({ ...base, distance_is_pickup: true }), /Afhentning/);
});

test('compact: kun emoji, antal og km', () => {
    const C = load();
    const h = C.lineHtml({ ...base, last_sentiment: 'positive', activity_count: 4, distance_km: 12,
        delivery_postal_code: '4000', last_contact_type: 'call', last_contact_at: '2026-09-01 10:00:00' }, { compact: true });
    assert.match(h, /💬 4/);
    assert.doesNotMatch(h, / God/);
    assert.doesNotMatch(h, />[^<]*4000/, 'postnr kun i tooltip');
    assert.doesNotMatch(h, /Ingen tidligere kontakt/);
    assert.strictEqual(C.lineHtml({ ...base }, { compact: true }), '', 'intet at vise → ingen tom linje på kortet');
});

test('historik: begge halvdele, og en fejl i ordrerne skjuler ikke aktiviteterne', async () => {
    const C = load({
        acts: async () => [{ type: 'call', result: 'reached', sentiment: 'positive', text: 'Glad <3',
            done_at: '2026-09-10 09:00:00', is_colleague: true, customer_name: 'Bo' },
            { type: 'followup', text: 'Ring', due_at: '2026-10-01 09:00:00', is_planned: true }],
        orders: async () => { throw new Error('boom'); },
    });
    const el = { dataset: {}, style: {}, innerHTML: '' };
    await C.toggleHistory(el, 1);
    assert.match(el.innerHTML, /Glad &lt;3/);
    assert.match(el.innerHTML, /· Bo/);
    assert.match(el.innerHTML, /planlagt 1\/10/);
    assert.match(el.innerHTML, /Fejl: boom/);
    await C.toggleHistory(el, 1);
    assert.strictEqual(el.style.display, 'none', 'andet klik folder ind');
});

test('historik uden kontaktperson henter intet', async () => {
    let called = false;
    const C = load({ acts: async () => { called = true; return []; } });
    const el = { dataset: {}, style: {}, innerHTML: '' };
    await C.toggleHistory(el, 0);
    assert.strictEqual(called, false);
    assert.match(el.innerHTML, /Ingen kontaktperson/);
});

test('alle lister (office + mobil) bruger modulet — ingen lokale kopier', () => {
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
    assert.match(read('office/views/crm-dashboard.js'), /CrmContactContext\.lineHtml\(c\)/);
    assert.match(read('shared/crm_worklist.js'), /_ctx\.lineHtml\(r\)/);
    assert.match(read('office/views/crm-outreach.js'), /CrmContactContext\.lineHtml\(m, \{ compact: true \}\)/);
    assert.match(read('office/index.html'), /crm_contact_context\.js/);
    assert.match(read('mobile/views/crm.js'), /CrmContactContext\.lineHtml\(sc\)/);
    assert.match(read('mobile/views/crm.js'), /CrmContactContext\.toggleHistory\(slot, sc\.customer_id\)/);
    assert.match(read('mobile/index.html'), /crm_contact_context\.js[\s\S]*views\/crm\.js/, 'modulet loades FØR mobilens crm.js');
    assert.doesNotMatch(read('office/views/crm-dashboard.js'), /_CRM_SENT|_crmSvcContextHtml/);
});
