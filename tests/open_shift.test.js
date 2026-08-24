/**
 * tests/open_shift.test.js
 * ════════════════════════════════════════════════════════════
 * "Er vagten ledig?" — ét udtryk, fire forbrugere.
 *
 * En vagt uden ejer er udlagt, men ikke taget. Ingen har arbejdet den, så den
 * er hverken mandetimer eller løn. Den talte alligevel med i driftens
 * persontimer (og trak kapacitetsraten ned) og dukkede op i advarslen som et
 * navnløst "?" der bad om en timeløn til en person der ikke findes.
 *
 * Reglen lå tidligere to steder med to forskellige definitioner:
 * ugeoversigten testede på NAVN, mens driften og eventets løn slet ikke
 * testede. Nu bor den i smartplanAdapter, hvor alle tre normaliseringer går
 * igennem — derfor testes den her, hvor den faktisk bestemmes.
 * ════════════════════════════════════════════════════════════
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _isOpenShift } = require('../services/smartplanAdapter');

test('ingen ejer = ledig vagt', () => {
    assert.equal(_isOpenShift(null), true, 'owner mangler helt');
    assert.equal(_isOpenShift(undefined), true);
    assert.equal(_isOpenShift({}), true, 'tomt owner-objekt');
    assert.equal(_isOpenShift({ uuid: null }), true, 'uuid udtrykkeligt null');
    assert.equal(_isOpenShift({ uuid: '' }), true, 'tom uuid tæller ikke som ejer');
});

test('en ejer = taget, også uden navn', () => {
    // Navnet er IKKE signalet. Ugeoversigten testede før på for-/efternavn, og
    // en vagt med ejer men uden udfyldt navn ville dermed se ledig ud ét sted
    // og taget ud et andet — netop den slags uenighed reglen skal fjerne.
    assert.equal(_isOpenShift({ uuid: 'abc' }), false, 'uuid alene er nok');
    assert.equal(_isOpenShift({ uuid: 'abc', first_name: null, last_name: null }), false,
        'ejer uden navn er stadig en ejer');
    assert.equal(_isOpenShift({ uuid: 'abc', first_name: 'Anne' }), false);
});

test('navn uden uuid er ikke en ejer', () => {
    // Modsat retning: et navn uden uuid kan vi ikke slå en timeløn op på, og
    // vagten kan ikke knyttes til en person. Den regnes som ledig.
    assert.equal(_isOpenShift({ first_name: 'Anne', last_name: 'Hansen' }), true);
});
