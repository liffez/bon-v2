/**
 * tests/wage_csv.test.js
 * ════════════════════════════════════════════════════════════
 * Løn-CSV'ens parser — med Smartplans eget eksport-format.
 *
 * Smartplans API udleverer IKKE timelønnen (verificeret på det rå
 * /members/-svar, august 2026: uuid, navn, email, telefon, initialer,
 * is_admin, user_type, jobtypes[], image — ingen sats). Derfor bliver satserne
 * ved med at bo i Bon.
 *
 * Men Smartplan har en "Eksportér til Excel" netop dér hvor satserne står, og
 * den fil kan importeres — hvis parseren kan læse deres løntype-tekst.
 * Ellers skal tallene tastes af i hånden, og så driver de to lister fra
 * hinanden. Hvilket de GJORDE: i august 2026 afveg seks satser og tre manglede.
 * ════════════════════════════════════════════════════════════
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// parseRate er intern i routen (ingen DB-afhængighed) — hentes ud som ren
// funktion, så testen rammer den ÆGTE kode og ikke en kopi.
const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'wage_rates.js'), 'utf8');
const parseRate = new Function(src.match(/function parseRate\(raw\) \{[\s\S]*?\n\}/)[0] + '; return parseRate;')();

test('Smartplans løntype-tekst → tallet i parentesen', () => {
    assert.equal(parseRate('køkkenbordet assistent (145,-)'), 145);
    assert.equal(parseRate('Senior køkkenansvarlig (200,-)'), 200);
    assert.equal(parseRate('Køkken assistent (150,-)'), 150);
    assert.equal(parseRate('Salgsassistent (135,-)'), 135);
    assert.equal(parseRate('Senior køkken assistent (180,-)'), 180);
});

test('ingen sats valgt → ingen sats', () => {
    // "Vælg timeløn" er Smartplans placeholder. Den må ikke blive til et tal.
    assert.equal(parseRate('Vælg timeløn'), null);
    assert.equal(parseRate(''), null);
    assert.equal(parseRate('   '), null);
});

test('tekst uden parentes afvises frem for at gætte', () => {
    // Et tal midt i en tekst kan være hvad som helst. Et gæt på en timeløn er
    // værre end en afvist række: det ville lande i regnskabet som en sandhed.
    assert.equal(parseRate('assistent 2'), null);
    assert.equal(parseRate('Køkken assistent'), null);
    assert.equal(parseRate('vikar 145 kr/t'), null);
});

test('almindelige tal er uændrede (regression)', () => {
    assert.equal(parseRate('180'), 180);
    assert.equal(parseRate('182,50'), 182.5);      // dansk decimalkomma
    assert.equal(parseRate('182.50'), 182.5);      // engelsk decimal
    assert.equal(parseRate('1.250,75'), 1250.75);  // dansk tusind + decimal
    assert.equal(parseRate('0'), null, 'nul er ikke en gyldig sats');
    assert.equal(parseRate('-50'), null, 'negativ er ikke en gyldig sats');
});
