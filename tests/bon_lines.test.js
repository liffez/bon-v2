// tests/bon_lines.test.js
// Smoke-test for shared/bon_lines.js
// Køres via:  node --test tests/bon_lines.test.js

const test = require('node:test');
const assert = require('node:assert');

const { mergeLines } = require('../shared/bon_lines');

const line = (over = {}) => Object.assign({
    id: 1,
    product_name: 'Kartoflen slider',
    grocy_recipe_id: 42,
    category: '03 Slider',
    quantity: 1,
    unit: 'stk',
    unit_price: 56,
    line_total: 56,
    is_accessory: 0,
    special_request: null,
    menu_group_id: null,
    block_type: null,
}, over);

test('ens linjer lægges sammen til én', () => {
    const r = mergeLines([
        line({ id: 1 }),
        line({ id: 2 }),
        line({ id: 3 }),
    ]);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].quantity, 3);
    assert.strictEqual(r[0].line_total, 168);
    assert.deepStrictEqual(r[0].merged_line_ids, [1, 2, 3]);
});

test('#B4154-casen: 3+2 spredt over rækker, rækkefølge bevaret', () => {
    const r = mergeLines([
        line({ id: 1, product_name: 'Kartoflen slider', quantity: 3, line_total: 168 }),
        line({ id: 2, product_name: 'Falaflen - slider', unit_price: 60, quantity: 2, line_total: 120 }),
        line({ id: 3, product_name: 'Kartoflen slider', quantity: 1, line_total: 56 }),
    ]);
    assert.strictEqual(r.length, 2);
    assert.strictEqual(r[0].product_name, 'Kartoflen slider');
    assert.strictEqual(r[0].quantity, 4);
    assert.strictEqual(r[1].product_name, 'Falaflen - slider');
    assert.strictEqual(r[1].quantity, 2);
});

test('forskellig stykpris slås ikke sammen', () => {
    const r = mergeLines([line({ id: 1, unit_price: 56 }), line({ id: 2, unit_price: 60 })]);
    assert.strictEqual(r.length, 2);
});

test('forskellig menugruppe slås ikke sammen', () => {
    const r = mergeLines([line({ id: 1, menu_group_id: null }), line({ id: 2, menu_group_id: 7 })]);
    assert.strictEqual(r.length, 2);
});

test('særønske holdes altid adskilt — også to ens særønsker', () => {
    const r = mergeLines([
        line({ id: 1, special_request: 'uden løg' }),
        line({ id: 2, special_request: 'uden løg' }),
        line({ id: 3 }),
    ]);
    assert.strictEqual(r.length, 3);
});

test('emballage og menuvare med samme navn blandes ikke', () => {
    const r = mergeLines([
        line({ id: 1, product_name: 'Transportkasse', is_accessory: 0 }),
        line({ id: 2, product_name: 'Transportkasse', is_accessory: 1 }),
    ]);
    assert.strictEqual(r.length, 2);
});

test('line_total forbliver null når ingen af linjerne har pris', () => {
    const r = mergeLines([
        line({ id: 1, unit_price: null, line_total: null }),
        line({ id: 2, unit_price: null, line_total: null }),
    ]);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].quantity, 2);
    assert.strictEqual(r[0].line_total, null);
});

test('input muteres ikke', () => {
    const input = [line({ id: 1 }), line({ id: 2 })];
    mergeLines(input);
    assert.strictEqual(input[0].quantity, 1);
    assert.strictEqual(input.length, 2);
});

test('tomt og enkelt-element input håndteres', () => {
    assert.deepStrictEqual(mergeLines([]), []);
    assert.deepStrictEqual(mergeLines(null), []);
    assert.strictEqual(mergeLines([line()]).length, 1);
});

test('samlet antal bevares (18 enheder forbliver 18)', () => {
    const raw = [];
    for (let i = 0; i < 18; i++) raw.push(line({ id: i + 1, quantity: 1 }));
    const r = mergeLines(raw);
    assert.strictEqual(r.reduce((s, l) => s + l.quantity, 0), 18);
});
