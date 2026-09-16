// tests/enquiry_mailto.test.js
// ==========================================================================
// buildEnquiryMailto(): "Skriv til os direkte" bærer det kunden har skrevet.
//
// Når en af de tre spærre-notitser (ferielukket, lukket ugedag, deadline
// passeret) rammer, HAR kunden allerede udfyldt hele formularen. En mailto
// uden body smed det væk og bad hende taste alt om — og mailen landede i
// bon@ uden navn, uden dato og uden antal.
//
// Mailto frem for kontaktformularen er et bevidst valg: mailen kommer fra
// kundens EGEN adresse, og det er dét der lader indbakken koble den til
// kunden (#478/#482). Kontaktformularen ville oprette en CRM-opgave uden
// dato, antal og varelinjer.
//
// Browserkode kan ikke require's, så de rigtige funktioner skæres ud af
// bestilling.html og køres i en vm-sandkasse med en attrap-DOM. Det er de
// SAMME funktioner browseren bruger, ikke en kopi.
//
// Kør: node --test tests/enquiry_mailto.test.js
// ==========================================================================

const test   = require('node:test');
const assert = require('node:assert');
const vm     = require('node:vm');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'embed', 'bestilling.html'), 'utf8');
const SRC  = HTML.split('<script>').slice(1).map(s => s.split('</script>')[0]).join('\n');

/** Felter som formularen har dem når kunden har udfyldt alt. */
const FULDT_UDFYLDT = {
    first_name:      'Anne',
    last_name:       'Hansen',
    email:           'anne@firma.dk',
    phone:           '12 34 56 78',
    company:         'Firma ApS',
    'date-input':    '2026-09-17',
    'time-input':    '11:30',
    pax:             '25',
    'address-input': 'Vestergade 1, 1456 København K',
    delivery_extra:  '2. sal, ring på porttelefon',
    wishes:          '3× Kyllingen\n2× Falaflen',
};

/**
 * Skærer de rene funktioner ud af siden og kører dem mod en attrap-DOM.
 * `felter` mapper element-id → value; et id der ikke står der, findes ikke
 * i DOM'en (getElementById → null), så den defensive gren rammes.
 */
function load(felter) {
    const pick = (re, hvad) => {
        const m = SRC.match(re);
        assert.ok(m, 'fandt ikke ' + hvad + ' i bestilling.html');
        return m[0];
    };
    const kode = [
        pick(/const MONTHS_DA = \[[\s\S]*?\];/, 'MONTHS_DA'),
        pick(/const FALLBACK_EMAIL = '[^']*';/, 'FALLBACK_EMAIL'),
        pick(/const MAILTO_WISHES_MAX = \d+;/, 'MAILTO_WISHES_MAX'),
        pick(/function fmtDaDate\([\s\S]*?\n}/, 'fmtDaDate'),
        pick(/function fieldValue\([\s\S]*?\n}/, 'fieldValue'),
        pick(/function buildEnquiryMailto\([\s\S]*?\n}/, 'buildEnquiryMailto'),
    ].join('\n');

    const ctx = {
        parseInt, encodeURIComponent, String, Array, Object,
        document: {
            getElementById(id) {
                return Object.prototype.hasOwnProperty.call(felter, id)
                    ? { value: felter[id] }
                    : null;
            },
        },
    };
    vm.createContext(ctx);
    // `const`/`function` bindes ikke på sandkassens global i strict-agtig brug
    // — hent dem via scriptets slutværdi, som dawa-testen gør.
    return vm.runInContext(kode + '\n;({ buildEnquiryMailto, FALLBACK_EMAIL })', ctx);
}

/** Pak mailto'en ud som en mailklient ville. */
function parse(href) {
    const u = new URL(href);
    return {
        protocol: u.protocol,
        til:      decodeURIComponent(u.pathname),
        subject:  u.searchParams.get('subject'),
        body:     u.searchParams.get('body'),
        raw:      href,
    };
}

const INTRO = 'Jeg vil gerne bestille til levering 17. september, men formularen siger at deadline er passeret.';

/* ──────────────────────────────────────────────────────────────
   §1 Kunden skal ikke taste noget om
   ────────────────────────────────────────────────────────────── */

test('body bærer alle de felter kunden allerede har udfyldt', () => {
    const { buildEnquiryMailto, FALLBACK_EMAIL } = load(FULDT_UDFYLDT);
    const m = parse(buildEnquiryMailto('Hastebestilling 2026-09-17', INTRO));

    assert.strictEqual(m.protocol, 'mailto:');
    assert.strictEqual(m.til, FALLBACK_EMAIL);
    assert.strictEqual(m.subject, 'Hastebestilling 2026-09-17');

    assert.ok(m.body.startsWith(INTRO), 'intro-linjen står øverst');
    assert.match(m.body, /^Navn: Anne Hansen$/m);
    assert.match(m.body, /^E-mail: anne@firma\.dk$/m);
    assert.match(m.body, /^Telefon: 12 34 56 78$/m);
    assert.match(m.body, /^Firma: Firma ApS$/m);
    assert.match(m.body, /^Tidspunkt: 11:30$/m);
    assert.match(m.body, /^Antal gæster: 25$/m);
    assert.match(m.body, /^Adresse: Vestergade 1, 1456 København K$/m);
    assert.match(m.body, /^Leveringsinfo: 2\. sal, ring på porttelefon$/m);
    assert.match(m.body, /^3× Kyllingen$/m, 'ønskerne er med');
    assert.match(m.body, /^2× Falaflen$/m);
    assert.match(m.body, /Venlig hilsen\nAnne Hansen$/, 'underskriften afslutter mailen');
});

test('datoen står både læsbart og som ISO — kontoret skal kunne slå den op', () => {
    const { buildEnquiryMailto } = load(FULDT_UDFYLDT);
    const m = parse(buildEnquiryMailto('s', INTRO));
    assert.match(m.body, /^Leveringsdato: 17\. september \(2026-09-17\)$/m);
});

/* ──────────────────────────────────────────────────────────────
   §2 Tomme og manglende felter
   ────────────────────────────────────────────────────────────── */

test('tomme felter udelades — ingen "Firma: " uden firma', () => {
    const { buildEnquiryMailto } = load({ ...FULDT_UDFYLDT, company: '', delivery_extra: '   ' });
    const m = parse(buildEnquiryMailto('s', INTRO));
    assert.ok(!/^Firma:/m.test(m.body), 'tomt firma må ikke give en tom linje');
    assert.ok(!/^Leveringsinfo:/m.test(m.body), 'whitespace tæller som tomt');
    assert.match(m.body, /^Navn: Anne Hansen$/m, 'de udfyldte felter er der stadig');
});

test('en tom formular giver stadig et link der virker', () => {
    const { buildEnquiryMailto, FALLBACK_EMAIL } = load({});
    const m = parse(buildEnquiryMailto('Hastebestilling', INTRO));
    assert.strictEqual(m.til, FALLBACK_EMAIL);
    assert.strictEqual(m.body.trim(), INTRO, 'kun introen — intet opdigtet');
});

test('et felt der ikke findes i DOM\'en kaster ikke', () => {
    // Cachet browser mod ny side, eller et felt der bliver omdøbt senere.
    const { buildEnquiryMailto } = load({ first_name: 'Anne' });
    const m = parse(buildEnquiryMailto('s', INTRO));
    assert.match(m.body, /^Navn: Anne$/m);
});

/* ──────────────────────────────────────────────────────────────
   §3 Ønsker er det eneste ubegrænsede felt
   ────────────────────────────────────────────────────────────── */

test('lange ønsker afkortes, men underskriften overlever', () => {
    const langt = 'x'.repeat(5000);
    const { buildEnquiryMailto } = load({ ...FULDT_UDFYLDT, wishes: langt });
    const m = parse(buildEnquiryMailto('s', INTRO));

    assert.ok(m.body.includes('[…afkortet]'), 'afkortningen siges højt');
    assert.ok(!m.body.includes(langt), 'hele teksten er ikke med');
    assert.match(m.body, /Venlig hilsen\nAnne Hansen$/, 'afkortning må ikke æde underskriften');
    assert.match(m.body, /^Navn: Anne Hansen$/m, 'eller kontaktoplysningerne');
    assert.ok(m.raw.length < 4000, 'URL\'en holder sig under det klienter klipper: ' + m.raw.length);
});

test('ønsker under grænsen afkortes ikke', () => {
    const { buildEnquiryMailto } = load(FULDT_UDFYLDT);
    const m = parse(buildEnquiryMailto('s', INTRO));
    assert.ok(!m.body.includes('[…afkortet]'));
});

/* ──────────────────────────────────────────────────────────────
   §4 URL'en indsættes i et href="" via innerHTML
   ────────────────────────────────────────────────────────────── */

test('URL\'en kan ikke bryde ud af href-attributten', () => {
    const { buildEnquiryMailto } = load({
        ...FULDT_UDFYLDT,
        // Alt hvad en kunde kan taste i et fritekstfelt.
        wishes:  'Han sagde "hej" & <script>alert(1)</script>',
        company: 'A" onmouseover="alert(1)',
    });
    const href = buildEnquiryMailto('s', INTRO);
    assert.ok(!href.includes('"'), 'et citationstegn ville lukke attributten');
    assert.ok(!href.includes('<'), 'ingen rå vinkelparenteser');
    assert.ok(!href.includes('>'), 'ingen rå vinkelparenteser');

    // …og indholdet er stadig intakt for modtageren.
    const m = parse(href);
    assert.ok(m.body.includes('Han sagde "hej" & <script>alert(1)</script>'));
});

/* ──────────────────────────────────────────────────────────────
   §5 Wiring: alle tre notitser bruger helperen
   ────────────────────────────────────────────────────────────── */

test('alle tre spærre-notitser bygger mailto\'en med buildEnquiryMailto', () => {
    const m = SRC.match(/function checkCutoff\(\)[\s\S]*?\n}\n/);
    assert.ok(m, 'fandt ikke checkCutoff');
    const krop = m[0];

    const kald = (krop.match(/buildEnquiryMailto\(/g) || []).length;
    assert.strictEqual(kald, 3, 'ferielukket + lukket ugedag + deadline');

    assert.ok(
        !/href="mailto:/.test(krop),
        'en bar mailto uden body er præcis det denne ændring fjernede',
    );
});
