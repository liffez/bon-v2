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

// parseWageCsv trækker på norm + splitCsvLine; hentes ud sammen, så testen
// rammer den ÆGTE parser og ikke en kopi.
const grab = (name) => src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'))[0];
const parseWageCsv = new Function(
    src.match(/const norm = [^;]+;/)[0] + grab('splitCsvLine') + grab('parseRate') + grab('parseWageCsv')
    + '; return parseWageCsv;')();

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

/* ── Smartplans eksport, som den faktisk ser ud ────────────────
   Semikolon-adskilt, navnet delt i Fornavn+Efternavn, sats-kolonnen hedder
   "Løntype", og værdien er "145,-" — dansk notation for hele kroner.
   Hver af de fire afveg fra hvad parseren forventede, og den fjerde var den
   grimme: "145,-" blev til "145.-" og dermed NaN, så rækken blev sprunget
   over UDEN en fejl. En import kunne rapportere "0 satser" på en fil med 12. */

const SMARTPLAN_EKSPORT = [
    'Fornavn;Efternavn;E-mail;Telefon;Jobtyper;Medarbejder lønnummer;Løntype;CPR nummer;Nøgle',
    'Anne;Lindhardt;info@nordicfastfood.dk;+45 22958845;Salgsassistent;175;;0406630064;ja',
    'Marija;Brescanovic;bresca.marija@gmail.com;+45 91859905;Salgsassistent;90;200,-;0202894364;ja',
    'Simon;Jensen;simo33@hotmail.dk;+45 51947224;Salgsassistent;178;160,-;1408016513;ja',
    'Leif;Zeeberg;liffez@gmail.com;+45 40195471;Bud, Frivillig, Salgsassistent;;;;ja',
    'Rebecca;Sophie Bolvig;beksen18@icloud.com;+45 27834632;Salgsassistent;;145,-;;nej',
].join('\n');

test('Smartplans eksport læses som den er', () => {
    const { rows, error } = parseWageCsv(SMARTPLAN_EKSPORT);
    assert.equal(error, null);
    assert.equal(rows.length, 3, 'kun rækker MED en løntype — Anne og Leif har ingen');

    const navne = rows.map(r => r.navn);
    assert.deepEqual(navne, ['Marija Brescanovic', 'Simon Jensen', 'Rebecca Sophie Bolvig'],
        'fornavn + efternavn sættes sammen i samme rækkefølge som rosteren bygger sit navn');
    assert.deepEqual(rows.map(r => r.timeloen), [200, 160, 145], '"145,-" er 145 kroner');
    assert.equal(rows[0].gyldig_fra, null, 'eksporten har ingen dato — kalderen bestemmer');
});

test('en tom løntype giver ikke en sats', () => {
    // Anne og Leif har tom Løntype. De må ikke få 0 eller en gætteværdi —
    // deres eksisterende sats i Bon skal stå urørt.
    const { rows } = parseWageCsv(SMARTPLAN_EKSPORT);
    assert.ok(!rows.some(r => /Anne|Leif/.test(r.navn)), 'ingen række uden løntype');
});

test('komma inde i et semikolon-felt vælter ikke rækken', () => {
    // Leifs "Bud, Frivillig, Salgsassistent" står i ét felt. Med en
    // komma-delimiter ville rækken skride og satsen havne i en forkert kolonne.
    const csv = [
        'Fornavn;Efternavn;Jobtyper;Løntype',
        'Leif;Zeeberg;Bud, Frivillig, Salgsassistent;175,-',
    ].join('\n');
    const { rows } = parseWageCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].navn, 'Leif Zeeberg');
    assert.equal(rows[0].timeloen, 175, 'satsen læses fra den rigtige kolonne');
});

test('vores eget format virker uændret (regression)', () => {
    const csv = 'navn,initialer,timeloen,gyldig_fra\nAnne Lindhardt,AL,182.50,2026-01-01';
    const { rows, error } = parseWageCsv(csv);
    assert.equal(error, null);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].navn, 'Anne Lindhardt');
    assert.equal(rows[0].initialer, 'AL');
    assert.equal(rows[0].timeloen, 182.5);
    assert.equal(rows[0].gyldig_fra, '2026-01-01', 'en dato i filen vinder over kalderens');
});
