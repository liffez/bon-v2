// scripts/test-recipe-steps.js
// ============================================================
// Fremgangsmåden i Grocys ENE beskrivelsesfelt (designer-spec §9).
//
// Feltet er fri HTML skrevet i Grocys editor — 32 af de 34 beskrivelser i
// drift. Derfor er den vigtigste regel ikke hvordan trin FORMATERES, men at
// et felt ingen har rørt skrives tilbage BYTE FOR BYTE (I4/R9.3). Ellers
// omskriver det første Gem på en hvilken som helst opskrift dens formatering
// — en tavs ændring ingen har bedt om, og den fejlklasse vi kender fra
// #305/#319.
//
// Fixturen er et read-only udtræk fra grocy-hq, så de fire beskrivelser der
// måles på er ægte — inkl. `Falaffel- stegning` (97), som ER nummererede trin
// når først Grocys `<span>`-indpakning er væk.
//
// Kør:  node scripts/test-recipe-steps.js
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

const RS = require('../shared/recipe_steps');
const SNAP = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'tests', 'fixtures', 'recipe_designer', 'hq_recipes.json'), 'utf8'));

const drift = SNAP.recipes.filter(r => r.description && String(r.description).trim());
const hent = (id) => SNAP.recipes.find(r => r.id === id);

// ── §1 Fra Grocys HTML til læsbare linjer ─────────────────────
console.log('\n── §1 HTML → linjer ──────────────────────────────────────');
{
    ok(JSON.stringify(RS.tilLinjer('<p>En</p><p>To</p>')) === JSON.stringify(['En', 'To']),
        '<p>-afsnit bliver til hver sin linje');
    ok(JSON.stringify(RS.tilLinjer('<ul><li>a</li><li>b</li></ul>')) === JSON.stringify(['a', 'b']),
        '<li> bliver til hver sin linje (Grocy-editorens punktopstilling)');
    ok(JSON.stringify(RS.tilLinjer('en<br>to')) === JSON.stringify(['en', 'to']),
        '<br> bryder linjen');
    // Fixturen har NUL navngivne entiteter — Grocy gemmer UTF-8 direkte. De to
    // asserts her er et værn mod tekst der kommer ind udefra, ikke en måling.
    ok(RS.tilLinjer('<p>R&oslash;dl&oslash;g &amp; salt</p>')[0] === 'Rødløg & salt',
        'danske bogstaver som entiteter afkodes');
    ok(RS.tilLinjer('<p>&AElig;g og &aelig;g</p>')[0] === 'Æg og æg',
        'store og små bogstaver er forskellige entiteter og bliver ikke ens');
    ok(RS.tilLinjer('<p>&bogus; står</p>')[0] === '&bogus; står',
        'en entitet vi ikke kender lades stå — vi gætter ikke på hvad den betyder');
    ok(RS.tilLinjer('<p>&#229;bn &#xe6;gget</p>')[0] === 'åbn ægget',
        'numeriske entiteter afkodes (både decimal og hex)');
    ok(RS.tilLinjer('<p><span>\t</span>1.<span>\t</span>Forvarm</span></p>')[0] === '1. Forvarm',
        'tabulator-indrykning fra Grocys editor klappes sammen — den er formatering, ikke indhold');
    ok(RS.tilLinjer('<p>a&nbsp;&nbsp;b</p>')[0] === 'a b',
        'hårde mellemrum klappes sammen');
    ok(JSON.stringify(RS.tilLinjer('ren tekst\nuden tags')) === JSON.stringify(['ren tekst', 'uden tags']),
        'et felt uden tags går uændret igennem');
    ok(RS.tilLinjer('').length === 0 && RS.tilLinjer(null).length === 0 && RS.tilLinjer('<p> </p>').length === 0,
        'tomt, null og et tomt afsnit giver ingen linjer');

    // Kontrolprøve: uden kollapsningen ville tabben stå tilbage. Beviser at
    // asserten ovenfor måler noget.
    ok(!/\t/.test(RS.tilLinjer('<p>a\tb</p>')[0]), 'kontrol: ingen tab overlever en linje');

    // Ægte drift: 28 er én `<ul>` med fire `<li>`. Bliver punkterne ikke til
    // hver sin linje, smøres hele fremgangsmåden sammen til én uigennemskuelig
    // strøm — og køkkenet læser den på skærmen.
    ok(RS.tilLinjer(hent(28).description).length >= 4,
        'en ægte punktopstilling fra Grocy (28) bliver til mindst fire linjer');
}

// ── §2 Nummer og tid på en linje ──────────────────────────────
console.log('\n── §2 Trin-start og [n min] ──────────────────────────────');
{
    ok(RS.erTrinStart('1. Skær kålen') && RS.erTrinStart('2) Kog lagen') && RS.erTrinStart(' 12.  Køl af'),
        '«1.», «2)» og indrykket «12.» indleder et trin');
    ok(!RS.erTrinStart('1.Skær') , 'et nummer uden mellemrum efter er ikke et trin (fx «1.5 kg»)');
    ok(!RS.erTrinStart('• Skær kålen') && !RS.erTrinStart('Tilberedning') && !RS.erTrinStart('3.'),
        'punkttegn, overskrift og et nøgent nummer indleder ikke et trin');

    const a = RS.traekTid('Kog lagen [4 min]');
    ok(a.text === 'Kog lagen' && a.minutes === 4, '«[4 min]» tages af og bliver til et tal');
    ok(RS.traekTid('Kog [4min]').minutes === 4 && RS.traekTid('Kog [4]').minutes === 4
        && RS.traekTid('Kog [4 m]').minutes === 4, '«4min», «4» og «4 m» forstås også');
    ok(RS.traekTid('Kog [1,5 min]').minutes === 1.5, 'dansk komma i tiden');
    const b = RS.traekTid('Kog lagen');
    ok(b.text === 'Kog lagen' && b.minutes === null, 'uden tid bliver minutes null, ikke 0');
    ok(RS.traekTid('Brug [se note] til sidst').minutes === null,
        'en kantet parentes uden tal er tekst, ikke en tid');
}

// ── §3 T7 Round-trip: trin ud og ind igen ─────────────────────
console.log('\n── §3 T7 Trin overlever gem → læs ────────────────────────');
{
    const trin = [
        { text: 'Skær kålen fint', minutes: 10 },
        { text: 'Kog lagen kortvarigt', minutes: null },
        { text: 'Hæld over og køl af', minutes: 1.5 },
    ];
    const gemt = RS.serializeSteps(trin, null, null);
    const igen = RS.parseDescription(gemt);

    ok(igen.mode === 'steps', 'det gemte læses tilbage som trin, ikke som fri tekst');
    ok(igen.steps.length === 3, 'alle tre trin kommer tilbage');
    ok(igen.steps.every((s, i) => s.text === trin[i].text),
        'teksterne er ord for ord de samme');
    ok(JSON.stringify(igen.steps.map(s => s.minutes)) === JSON.stringify([10, null, 1.5]),
        'tiderne er de samme — også det tomme og det med komma');
    ok(/^<p>1\. /.test(gemt) && gemt.includes('<p>3. '),
        'der skrives HTML-afsnit, ikke ren tekst — ellers ville Grocy rendere det som ét afsnit');
    ok(gemt.includes('[10 min]') && gemt.includes('[1,5 min]'),
        'tiden skrives med dansk komma');

    // Numrene skrives forfra: et slettet trin må ikke efterlade et hul.
    const uden = RS.serializeSteps([trin[0], trin[2]], null, null);
    ok(RS.parseDescription(uden).steps.length === 2 && uden.includes('<p>2. Hæld over'),
        'slettes et trin, nummereres de øvrige forfra');

    const medTomt = RS.serializeSteps(
        [trin[0], { text: '   ', minutes: 9 }, trin[1]], null, null);
    ok(!medTomt.includes('[9 min]') && RS.parseDescription(medTomt).steps.length === 2,
        'et trin uden tekst skrives ikke — heller ikke selvom nogen har tastet en tid på det');
    ok(medTomt.includes('<p>2. Kog lagen'),
        'og numrene lukker sig om hullet, så der ikke står 1, 3');

    // Kontrolprøve: round-trippet er ikke trivielt sandt.
    const ændret = RS.parseDescription(RS.serializeSteps(
        [{ text: 'Skær kålen groft', minutes: 10 }], null, null));
    ok(ændret.steps[0].text !== trin[0].text, 'kontrol: en ændret tekst kommer tilbage ændret');
}

// ── §4 T8 Fri tekst fra Grocy vises råt og røres ikke ─────────
console.log('\n── §4 T8 Grocys fri tekst må ikke skrives om ─────────────');
{
    const raw = '<p class="p1" style="font-size:13px;">Pres hvidløg, og rør det sammen med tahin.</p>';
    const p = RS.parseDescription(raw);

    ok(p.mode === 'raw', 'uden nummererede linjer er feltet fri tekst');
    ok(p.steps.length === 0, 'fri tekst giver ingen trin — vi opfinder ikke en struktur');
    ok(p.plain === 'Pres hvidløg, og rør det sammen med tahin.',
        'rå-visningen er teksten uden tags (R9.4)');
    ok(p.raw === raw, 'den oprindelige HTML bæres med, byte for byte');
    ok(RS.toStore(p, {}) === raw,
        'et Gem der ikke nævner beskrivelsen skriver PRÆCIS det samme tilbage (I4)');
    ok(RS.toStore(p, { plain: p.plain }) === raw,
        'og også når rå-visningen sendes uændret med — style-attributten overlever');

    // Kontrolprøve: rettes teksten, SKAL der skrives noget andet.
    const rettet = RS.toStore(p, { plain: 'Pres hvidløg, og rør det sammen med tahini.' });
    ok(rettet !== raw && rettet.includes('tahini') && rettet.startsWith('<p>'),
        'kontrol: rettes den rå tekst, skrives den — som <p>, så linjeskift overlever');
    ok(!rettet.includes('font-size'),
        'og så går Grocy-editorens formatering tabt — envejsændringen er reel og skal siges på skærmen');
}

// ── §5 T17 Trin + Importnote ──────────────────────────────────
console.log('\n── §5 T17 Importnoten er ikke et trin ────────────────────');
{
    const raw = '<p>1. Skær kålen [5 min]</p><p>2. Kog lagen</p>'
              + '<p>Importnote:</p><p>Kilde: Arla, hentet 12.09.2026</p><p>Mængder er gættet</p>';
    const p = RS.parseDescription(raw);

    ok(p.mode === 'steps' && p.steps.length === 2,
        'de to trin parses — notens linjer bliver IKKE til trin 3 og 4 (R9.5)');
    ok(p.steps[0].minutes === 5 && p.steps[1].minutes === null, 'tiderne følger de rigtige trin');
    ok(p.note === 'Kilde: Arla, hentet 12.09.2026\nMængder er gættet',
        'noten kommer med, uden præfikslinjen og med sine egne linjeskift');
    ok(RS.toStore(p, {}) === raw, 'urørt skrives feltet tilbage byte for byte');

    const skrevet = RS.toStore(p, { steps: [{ text: 'Skær kålen groft', minutes: 5 }, p.steps[1]] });
    const læst = RS.parseDescription(skrevet);
    ok(læst.note === p.note, 'rettes et trin, følger noten uændret med — den er ikke vores at slette');
    ok(skrevet.indexOf('Importnote:') > skrevet.indexOf('Kog lagen'), 'noten står efter trinnene');

    // Noten alene, uden trin.
    const kun = RS.parseDescription('<p>Fri beskrivelse</p><p>Importnote:</p><p>Kilde: X</p>');
    ok(kun.mode === 'raw' && kun.note === 'Kilde: X' && kun.plain.includes('Fri beskrivelse'),
        'en note uden trin: feltet er stadig fri tekst, og noten er stadig skilt ud');
    ok(!kun.plain.split('\n').slice(0, 1).join().includes('Importnote'),
        'kontrol: noten indgår i plain som den står — men den er læst som note, ikke som trin');
}

// ── §6 I4 De ÆGTE beskrivelser fra drift ──────────────────────
console.log('\n── §6 I4 Fire ægte beskrivelser fra grocy-hq ─────────────');
{
    ok(drift.length === 4, `fixturen bærer ${drift.length} ægte beskrivelser at måle på`);
    for (const r of drift) {
        const p = RS.parseDescription(r.description);
        ok(RS.toStore(p, {}) === r.description,
            `«${r.name}» (${r.id}, ${p.mode}) skrives tilbage byte for byte når intet er rørt`);
    }
    ok(drift.some(r => RS.parseDescription(r.description).mode === 'steps'),
        'mindst én af dem ER nummererede trin — trin-tilstanden nås i drift, den er ikke teoretisk');
    ok(drift.filter(r => /<\w/.test(r.description)).length === 4,
        'alle fire er HTML — derfor er byte-for-byte-reglen den vigtigste i filen');

    // Kontrolprøve: asserten ovenfor ville også bestå hvis toStore altid
    // returnerede raw. Her bevises at den IKKE gør det.
    const p97 = RS.parseDescription(hent(97).description);
    const rørt = RS.toStore(p97, { steps: p97.steps.map((s, i) => i ? s : { text: s.text + ' grundigt', minutes: s.minutes }) });
    ok(rørt !== p97.raw && rørt.includes('grundigt'),
        'kontrol: rettes et trin på (97), skrives der noget ANDET end den oprindelige tekst');
}

// ── §7 Overskriften før det første nummer ─────────────────────
console.log('\n── §7 Overskriften er ikke vores at slette ───────────────');
{
    const p = RS.parseDescription(hent(97).description);
    ok(p.lead === 'Tilberedning', '«Tilberedning» læses som overskrift, ikke som trin 0');
    ok(p.steps.length === 6 && !p.steps.some(s => s.text.startsWith('Tilberedning')),
        'den er heller ikke klistret ind i et trin');

    const rørt = RS.toStore(p, { steps: p.steps.map((s, i) => i ? s : { text: 'Forvarm ovnen til 200 grader.', minutes: null }) });
    ok(rørt.includes('Tilberedning'),
        'rettes et trin, står overskriften der stadig — ellers forsvandt den tavst ved første Gem');
    ok(rørt.indexOf('Tilberedning') < rørt.indexOf('<p>1. '), 'og den står øverst, hvor den stod');

    // Punkterne under hvert nummer i 97 er linjer UDEN nummer. Falder de på
    // gulvet, mister trinnet alt sit indhold — på 97 er det 10 af 16 linjer.
    ok(p.steps[1].text.includes('Smuldr TEMPTY-firkanterne')
        && p.steps[1].text.includes('Bland det grundigt'),
        'linjer uden nummer hænger på trinnet ovenfor — de forsvinder ikke');
    const ombrudt = RS.parseDescription('<p>1. Første del</p><p>og fortsat her</p><p>2. Næste</p>');
    ok(ombrudt.steps.length === 2 && ombrudt.steps[0].text === 'Første del og fortsat her',
        'fortsatte linjer klistres sammen med ét mellemrum, ikke som et nyt trin');

    const syntetisk = RS.parseDescription('<p>Overskrift</p><p>Og en linje til</p><p>1. Gør noget</p>');
    ok(syntetisk.lead === 'Overskrift\nOg en linje til', 'flere linjer før det første nummer bæres alle med');
    ok(RS.parseDescription('<p>1. Gør noget</p>').lead === null, 'uden overskrift er lead null, ikke tom streng');
}

// ── §8 «ikke rørt» er ikke det samme som «ryddet» ─────────────
console.log('\n── §8 undefined betyder ikke rørt ────────────────────────');
{
    const p = RS.parseDescription('<p>1. Skær kålen</p>');
    ok(RS.toStore(p, {}) === p.raw, 'ingen steps i kaldet = feltet er ikke rørt');
    ok(RS.toStore(p, { steps: undefined }) === p.raw, 'eksplicit undefined er også «ikke rørt»');
    ok(RS.toStore(p, { steps: [] }) === '', 'en TOM liste er derimod «ryddet» og tømmer feltet');
    ok(RS.toStore(p, null) === p.raw && RS.toStore(p, undefined) === p.raw,
        'null og udeladt argument opfører sig som «ikke rørt»');

    // Fri tekst: samme skel.
    const f = RS.parseDescription('<p>Fri tekst</p>');
    ok(RS.toStore(f, {}) === f.raw, 'fri tekst uden edits er urørt');
    ok(RS.toStore(f, { steps: [{ text: 'Nu et trin', minutes: null }] }).includes('<p>1. Nu et trin</p>'),
        'får fri tekst trin, skrives den om til trin');
}

// ── §9 Samlet tid ─────────────────────────────────────────────
console.log('\n── §9 Samlet tid ─────────────────────────────────────────');
{
    ok(RS.totalMinutes([{ minutes: 10 }, { minutes: 5 }]) === 15, 'tiderne lægges sammen');
    ok(RS.totalMinutes([{ minutes: 10 }, { minutes: null }]) === 10, 'trin uden tid tæller som ingenting');
    ok(RS.totalMinutes([{ minutes: null }, { minutes: null }]) === null,
        'har INTET trin en tid, er svaret null — ikke 0. 0 minutter ville være en påstand');
    ok(RS.totalMinutes([]) === null && RS.totalMinutes(null) === null, 'tom og null giver null');
    ok(RS.totalMinutes([{ minutes: 1.5 }, { minutes: 1.5 }]) === 3, 'decimaler lægges sammen');
}

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' PASS · ' + fail + ' FAIL\x1b[0m\n');
process.exit(fail ? 1 : 0);
