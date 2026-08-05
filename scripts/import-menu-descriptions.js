// scripts/import-menu-descriptions.js
// ==========================================
// Fylder feltet "Kort salgstekst" (description) på bestillingsmenuens retter
// med teksterne fra ristetrug.dk/menu (hentet 6. august 2026).
//
// Beskrivelsen vises bag ⓘ på både bon-bestillingsformen og event-order-3's
// forudbestillingsside (gennem event-broen). Uden den står retterne kun med
// navn + allergener.
//
// Teksterne er ordrette fra hjemmesiden, på nær fire bevidste indgreb — alle
// markeret med NOTE nedenfor:
//   1. Fodnote-stjerner (* / **) er fjernet. De henviser til fodnoter under
//      menukortet ("* ikke økologisk") som ikke findes på bestillingssiden,
//      hvor de derfor ville stå som støj.
//   2. "skriver af rå æble" → "skiver af rå æble" (åbenlys tastefejl på sitet).
//   3. Slider-varianterne arver standard-rettens tekst — samme ret, halv størrelse.
//   4. Slider-bokse og børnebokse er skrevet ud pr. variant ud fra varenavnet,
//      da sitet kun har én fælles tekst for hver.
//
// Matcher på menu-item-id ('r<grocy_id>'), med eksakt navne-match som fallback
// hvis menuen er genimporteret med nye id'er. Retter der ALLEREDE har en
// beskrivelse røres ikke (medmindre --force) — så scriptet kan køres igen uden
// at overskrive noget office har rettet i hånden.
//
// Dry-run først (skriver ikke):
//   node --experimental-sqlite scripts/import-menu-descriptions.js
// Og derefter:
//   node --experimental-sqlite scripts/import-menu-descriptions.js --apply
//
// Kræver ikke Grocy. Rører kun settings-nøglen bestilling.menu_standard.
// ==========================================

const path = require('path');
const fs = require('fs');
const { openDb } = require('../db/compat');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');
const MENU_KEY = 'bestilling.menu_standard';

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');

// ─── Teksterne (kilde: ristetrug.dk/menu) ──────────────────────────────────
// name = navnet retten havde i menuen da listen blev lavet. Bruges kun til
// fallback-matching og til at vise et tydeligt output — id'et er nøglen.
const SANDWICH = {
    r23:  'Kogte kartofler, frisk grønt på løvstikkemayo, drysset med flagesalt og klippet purløg toppet med vores tranebær-syltede rødløg.',
    r91:  'Sprøde falafler, frisk grønt på tahin-mayo med granatæblesirup toppet med yoghurt dressing og tranebær-syltede rødløg.',
    r34:  'Kogt æg, frisk grønt på mayonnaise, drysset med flagesalt og klippet purløg toppet med vores tranebær-syltede rødløg.',
    r161: 'Frisklavet æggesalat med karry, frisk grønt, skiver af rå æble og purløg.',
    r63:  'Ingrid ærter, majs, rødløg, frisk grønt på vegansk chili mayo, toppet med klippet purløg og vores tranebær-syltede rødløg.',
    r92:  'Sprøde falafler, frisk grønt på trøffelmayo, toppet med bagte løg, semidried tomater og smuldret fetaost.',
    r26:  'Mozzarella, frisk grønt på pesto med friske og semidried tomater toppet med balsamico glace.',
    r24:  'Fiskefrikadelle af lys fisk, frisk grønt på grov remoulade toppet med citron- og ingefærsyltede gulerødder.',
    r33:  'Grillet lufttørret skinke, skiveost, frisk grønt på sennepsmayo toppet med semidried tomater.',
    r88:  'BBQ-marineret kylling, frisk grønt på chili mayo med soltørrede tomater toppet med valnødder.',
    r25:  'Vores frikadelle af dansk gris/okse og hvide bønner, frisk grønt på sennepsmayo toppet med råsyltet rødkål.',
    r27:  'Langtidsstegt dansk gris, frisk grønt på løvstikkemayo med hjemmelavet æblechutney toppet med sprøde æbler.',
};

// slider-id → den standard-ret den er en halv udgave af (NOTE 3)
const SLIDER_OF = {
    r57: 'r23', r93: 'r91', r62: 'r34', r162: 'r161', r61: 'r63',
    r54: 'r26', r52: 'r24', r60: 'r33', r111: 'r88', r53: 'r25', r55: 'r27',
};

const ITEMS = [
    // Sandwich
    { id: 'r23',  name: 'Kartoflen',    text: SANDWICH.r23 },
    { id: 'r91',  name: ' Falaflen',    text: SANDWICH.r91 },
    { id: 'r34',  name: 'Ægget',        text: SANDWICH.r34 },
    { id: 'r161', name: 'Æggesalaten',  text: SANDWICH.r161 },
    { id: 'r63',  name: '"Tunen"',      text: SANDWICH.r63 },
    { id: 'r92',  name: 'Trøflen',      text: SANDWICH.r92 },
    { id: 'r26',  name: 'Italieneren',  text: SANDWICH.r26 },
    { id: 'r24',  name: 'Fisken',       text: SANDWICH.r24 },
    { id: 'r33',  name: 'Skinken',      text: SANDWICH.r33 },
    { id: 'r88',  name: 'Kyllingen',    text: SANDWICH.r88 },
    { id: 'r25',  name: 'Frikadellen',  text: SANDWICH.r25 },
    { id: 'r27',  name: 'Grisen på Rug', text: SANDWICH.r27 },

    // Slidere — samme ret, halv størrelse
    { id: 'r57',  name: 'Kartoflen slider' },
    { id: 'r93',  name: 'Falaflen - slider' },
    { id: 'r62',  name: 'Ægget slider' },
    { id: 'r162', name: 'Æggesalaten slider' },
    { id: 'r61',  name: '"Tunen" Spicy  slider' },
    { id: 'r54',  name: 'Italieneren slider' },
    { id: 'r52',  name: 'Fisken Slider' },
    { id: 'r60',  name: 'Skinken slider' },
    { id: 'r111', name: 'Kyllingen slider' },
    { id: 'r53',  name: 'Frikadellen Slider' },
    { id: 'r55',  name: 'Grisen på Rug slider' },

    // Slider-bokse (NOTE 4)
    { id: 'r77', name: 'Alm slider Boks - fisken, Frikadellen, kartoflen',
      text: 'En boks med 3 sliders — Fisken, Frikadellen og Kartoflen. Det svarer til 1,5 sandwich.' },
    { id: 'r78', name: 'Vegetar slider Boks - Æg, DK Italiener, kartoffel',
      text: 'En boks med 3 vegetariske sliders — Ægget, Italieneren og Kartoflen. Det svarer til 1,5 sandwich.' },

    // Salater
    { id: 'r66', name: 'Kålen - Salat',
      text: 'Kål, citron, olivenolie, salte mandler, parmesan + 1/2 Ristet Rug brød.' },
    { id: 'r67', name: 'Bønnen - Salat',
      text: 'Bønnemix, spinat, kål, olie/eddike, persille + 1/2 Ristet Rug brød.' },
    { id: 'r68', name: 'Kyllingen BBQ- Salat',
      text: 'BBQ kylling, kål, spinat, soltørrede tomater, valnødder, chili mayo + 1/2 Ristet Rug brød.' },
    { id: 'r69', name: 'Kartoflen - Salat',
      text: 'Majs, kartofler, Ingrid ærter, cornichoner, spinat, olie/eddike, citron, sennep + 1/2 Ristet Rug brød.' },

    // Kage
    { id: 'r64', name: 'Cookie', text: 'Vores knasende, hjemmebagte cookie med rug.' },

    // Bokse (NOTE 4)
    { id: 'r71', name: 'Børne Boks - Delle',
      text: 'Boks med 1 lun frikadelle, 2 små tomater, 2 skiver agurk, 1/2 Ristet Rug brød.' },
    { id: 'r72', name: 'Børne Boks - Fisk',
      text: 'Boks med 1 lun fiskefrikadelle, 2 små tomater, 2 skiver agurk, 1/2 Ristet Rug brød.' },
];

// Slidere arver teksten fra deres standard-ret.
for (const it of ITEMS) {
    if (!it.text && SLIDER_OF[it.id]) it.text = SANDWICH[SLIDER_OF[it.id]];
}

// Retter uden tekst på hjemmesiden: Brownie + de tre drikkevarer. Bevidst
// udeladt — vi opfinder ikke salgstekster.

// ─── Kørsel ────────────────────────────────────────────────────────────────
const norm = s => String(s || '').toLowerCase().replace(/["'”“]/g, '').replace(/\s+/g, ' ').trim();

function main() {
    if (!fs.existsSync(DB_PATH)) {
        console.error(`Databasen findes ikke: ${DB_PATH}`);
        process.exit(1);
    }
    const db = openDb(DB_PATH);

    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(MENU_KEY);
    if (!row) {
        console.error(`Ingen bestillingsmenu i settings (${MENU_KEY}).`);
        process.exit(1);
    }
    const menu = JSON.parse(row.value);
    const items = menu.items || [];

    const byId = new Map(items.map(it => [String(it.id), it]));
    const byName = new Map();
    for (const it of items) {
        const k = norm(it.name);
        // Kun entydige navne må bruges som fallback — flere "Kartoflen" ville
        // ellers kunne give en salat en sandwich-tekst.
        byName.set(k, byName.has(k) ? null : it);
    }

    const rows = [];
    let changed = 0, skipped = 0, missing = 0;

    for (const src of ITEMS) {
        let target = byId.get(src.id);
        let via = 'id';
        if (!target) {
            const byN = byName.get(norm(src.name));
            if (byN) { target = byN; via = 'navn'; }
        }
        if (!target) {
            rows.push([src.id, src.name, 'IKKE FUNDET i menuen', '']);
            missing++;
            continue;
        }
        const current = String(target.description || '').trim();
        if (current && !FORCE) {
            rows.push([target.id, target.name, 'har allerede tekst — urørt', current.slice(0, 40) + '…']);
            skipped++;
            continue;
        }
        if (current === src.text) {
            rows.push([target.id, target.name, 'uændret', '']);
            skipped++;
            continue;
        }
        target.description = src.text;
        rows.push([target.id, target.name, via === 'id' ? 'sættes' : 'sættes (matchet på navn)', src.text.slice(0, 60) + '…']);
        changed++;
    }

    // Retter i menuen som listen ikke dækker
    const covered = new Set(ITEMS.map(s => s.id));
    const uncovered = items.filter(it => !covered.has(String(it.id)) && !String(it.description || '').trim());

    const w = arr => arr.map(r => `  ${String(r[0]).padEnd(6)} ${String(r[1]).padEnd(46)} ${String(r[2]).padEnd(30)} ${r[3]}`).join('\n');
    console.log(`\nBestillingsmenu: ${items.length} retter i ${DB_PATH}\n`);
    console.log(w(rows));
    if (uncovered.length) {
        console.log(`\nUden beskrivelse (ingen tekst på hjemmesiden — skriv selv hvis I vil have en):`);
        for (const it of uncovered) console.log(`  ${String(it.id).padEnd(6)} ${it.name}`);
    }
    console.log(`\n${changed} sættes · ${skipped} springes over · ${missing} ikke fundet`);

    if (!APPLY) {
        console.log('\nDry-run — intet skrevet. Kør igen med --apply for at gemme.');
        console.log('(--force overskriver også retter der allerede har en tekst.)\n');
        return;
    }
    if (!changed) {
        console.log('\nIntet at ændre.\n');
        return;
    }

    // Backup af den gamle menu ved siden af databasen, så en fortrydelse er triviel.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-'); // utc-ok: filnavn
    const backup = path.join(path.dirname(DB_PATH), `menu_standard.backup-${stamp}.json`);
    fs.writeFileSync(backup, row.value);

    db.prepare('UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?')
      .run(JSON.stringify(menu), MENU_KEY);

    console.log(`\nGemt. Backup af den gamle menu: ${backup}\n`);
}

main();
