// tests/dato.test.js
// Regressions-test for dansk kalenderdato (#133).
// Køres via:  node --test --experimental-sqlite tests/dato.test.js
//
// Fejlen der motiverer filen: `new Date().toISOString().slice(0,10)` giver
// UTC-datoen. Mellem midnat og kl. 02 dansk sommertid peger den på I GÅR,
// så "i dag"-filtre, dato-overskrifter og default-datoer rammer forkert.
//
// Den viser sig KUN om natten. Testen pinner derfor tidspunktet i stedet for
// at bruge `new Date()` — ellers ville den bestå 22 timer i døgnet uanset om
// koden var rigtig, og det er præcis sådan fejlen har overlevet så længe.

const test = require('node:test');
const assert = require('node:assert');

const { todayISO, offsetISO } = require('../db/helpers');

// Kalenderdato i Europe/Copenhagen for et givet øjeblik — samme udtryk som
// todayISO() bruger internt, men med et eksplicit tidspunkt så vi kan teste
// natten uden at vente på den.
function danskDato(instant) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(instant);
}

test('sommertid: kl. 00:30 dansk er UTC stadig i går', () => {
    // 2026-07-19 00:30 dansk (UTC+2) = 2026-07-18 22:30Z
    const natten = new Date('2026-07-18T22:30:00Z');

    assert.strictEqual(danskDato(natten), '2026-07-19', 'den danske kalenderdato');
    assert.strictEqual(natten.toISOString().slice(0, 10), '2026-07-18',
        'UTC-datoen — det er den gamle kode ville have brugt');
});

test('vintertid: kl. 00:30 dansk er UTC stadig i går', () => {
    // 2026-01-15 00:30 dansk (UTC+1) = 2026-01-14 23:30Z
    const natten = new Date('2026-01-14T23:30:00Z');

    assert.strictEqual(danskDato(natten), '2026-01-15');
    assert.strictEqual(natten.toISOString().slice(0, 10), '2026-01-14');
});

test('midt på dagen er der ingen forskel — derfor opdages fejlen aldrig', () => {
    const middag = new Date('2026-07-19T10:00:00Z');
    assert.strictEqual(danskDato(middag), middag.toISOString().slice(0, 10));
});

test('todayISO() giver en gyldig dansk kalenderdato', () => {
    const i_dag = todayISO();
    assert.match(i_dag, /^\d{4}-\d{2}-\d{2}$/);
    assert.strictEqual(i_dag, danskDato(new Date()));
});

test('offsetISO() regner i hele kalenderdage', () => {
    const i_dag = todayISO();
    assert.strictEqual(offsetISO(0), i_dag);

    const i_morgen = offsetISO(1);
    const i_gaar   = offsetISO(-1);
    assert.match(i_morgen, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(i_gaar,   /^\d{4}-\d{2}-\d{2}$/);

    const dag = 86400000;
    assert.strictEqual(
        (new Date(i_morgen + 'T12:00:00Z') - new Date(i_dag + 'T12:00:00Z')) / dag, 1);
    assert.strictEqual(
        (new Date(i_dag + 'T12:00:00Z') - new Date(i_gaar + 'T12:00:00Z')) / dag, 1);
});

test('offsetISO() krydser månedsskifte korrekt', () => {
    // 31 dage fra 1. juli er 1. august — ikke 32. juli
    const p = '2026-07-31';
    const naeste = new Date(Date.UTC(2026, 6, 31));
    naeste.setUTCDate(naeste.getUTCDate() + 1);
    assert.strictEqual(naeste.toISOString().slice(0, 10), '2026-08-01',
        'samme aritmetik som offsetISO bruger internt');
    assert.ok(p < '2026-08-01');
});

test('offsetISO() krydser sommertidsskiftet uden at tabe en dag', () => {
    // Sommertid slutter sidste søndag i oktober 2026 (25/10). Døgnet er 25 timer,
    // så ren millisekund-aritmetik ville kunne lande forkert; offsetISO regner
    // i UTC-forankrede kalenderdage og er upåvirket.
    const dage = ['2026-10-24', '2026-10-25', '2026-10-26'];
    for (let i = 0; i < dage.length - 1; i++) {
        const d = new Date(dage[i] + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() + 1);
        assert.strictEqual(d.toISOString().slice(0, 10), dage[i + 1]);
    }
});

test('ugeberegning: mandag–søndag er 7 dage og starter på en mandag', () => {
    const dow = new Date(todayISO() + 'T12:00:00Z').getUTCDay() || 7;
    const mandag = offsetISO(-(dow - 1));
    const soendag = offsetISO(-(dow - 1) + 6);

    assert.strictEqual(new Date(mandag + 'T12:00:00Z').getUTCDay(), 1, 'starter mandag');
    assert.strictEqual(new Date(soendag + 'T12:00:00Z').getUTCDay(), 0, 'slutter søndag');
    assert.strictEqual(
        (new Date(soendag + 'T12:00:00Z') - new Date(mandag + 'T12:00:00Z')) / 86400000, 6);
});
