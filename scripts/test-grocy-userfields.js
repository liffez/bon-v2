// scripts/test-grocy-userfields.js
// ============================================================
// Erklæringen i scripts/ensure-grocy-userfields.js skal blive ved med at
// beskrive virkeligheden.
//
// Den farlige fejl er ikke en fejl i koden, men i LISTEN: et felt der får en
// tastefejl bliver oprettet under et navn ingen læser, og et felt der ikke
// længere bruges bliver ved med at blive oprettet på nye instanser. Begge dele
// er tavse. Derfor slås hvert erklæret navn op i kodebasen.
//
// Kører uden Grocy og uden DB.
//
// Kør:  node scripts/test-grocy-userfields.js
// ============================================================
'use strict';

const { execSync } = require('child_process');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

const ROOT = path.join(__dirname, '..');
const { ERKLAERING, kraevede, normType } = require('./ensure-grocy-userfields');

// Grocys egne typer. Står der noget andet, oprettes feltet med en ugyldig type
// — sådan som de 24 `text_single_line`-felter i drift er blevet til.
const GYLDIGE = new Set(['text-single-line', 'text-multi-line', 'number-integral',
    'number-decimal', 'date', 'datetime', 'checkbox', 'preset-list', 'preset-checklist',
    'link', 'file', 'image']);

function naevntIKoden(navn) {
    try {
        const ud = execSync(
            `grep -rl --include='*.js' --include='*.html' --include='*.sql' -- ${JSON.stringify(navn)} ` +
            `services routes shared scripts kitchen office mobile db 2>/dev/null | ` +
            `grep -v 'ensure-grocy-userfields\\|test-grocy-userfields' | wc -l`,
            { cwd: ROOT, shell: '/bin/bash' }).toString().trim();
        return parseInt(ud, 10) || 0;
    } catch (e) { return 0; }
}

console.log('\n── Erklæringen mod kodebasen ─────────────────────────────');
{
    const savnede = [];
    for (const [entity, e] of Object.entries(ERKLAERING)) {
        for (const [navn] of e.paakraevet) {
            if (naevntIKoden(navn) === 0) savnede.push(entity + '.' + navn);
        }
    }
    ok(savnede.length === 0,
        'hvert påkrævet felt kan findes i koden: ' + (savnede.join(', ') || 'alle fundet'));

    // Kontrolprøve: ville opslaget overhovedet kunne fejle?
    ok(naevntIKoden('zzt_findes_ikke_nogen_steder') === 0,
        'et opdigtet navn findes IKKE — ellers måler testen ovenfor ingenting');
    ok(naevntIKoden('recipeunitnumber') > 0, 'og et rigtigt navn findes');
}

console.log('\n── Erklæringens form ─────────────────────────────────────');
{
    const alle = kraevede(true);
    ok(alle.length >= 40, `${alle.length} felter erklæret`);

    const ugyldige = alle.filter(f => !GYLDIGE.has(f.type));
    ok(ugyldige.length === 0,
        'alle typer er gyldige Grocy-typer: ' + (ugyldige.map(f => f.navn + '=' + f.type).join(', ') || 'ja'));

    const set = new Set(), dubletter = [];
    for (const f of alle) {
        const k = f.entity + '.' + f.navn;
        if (set.has(k)) dubletter.push(k); else set.add(k);
    }
    ok(dubletter.length === 0, 'ingen dubletter: ' + (dubletter.join(', ') || 'nej'));

    const utomme = alle.filter(f => !f.caption || !f.brugt);
    ok(utomme.length === 0,
        'hvert felt siger hvad det hedder og hvem der bruger det: ' +
        (utomme.map(f => f.navn).join(', ') || 'ja'));

    // Kun Bons egne entiteter. `userentity-*`, equipment og chores tilhører
    // andre apps, og scriptet må aldrig foreslå at oprette noget dér.
    const fremmede = Object.keys(ERKLAERING).filter(e =>
        !['products', 'recipes', 'product_barcodes', 'shopping_list'].includes(e));
    ok(fremmede.length === 0, 'kun Bons fire entiteter: ' + (fremmede.join(', ') || 'ja'));

    ok(kraevede(false).every(f => !f.planlagt), 'planlagte felter er UDE uden --include-planned');
    ok(kraevede(true).some(f => f.planlagt), 'og MED når der bedes om det');
}

console.log('\n── De to skrivemåder for samme type ──────────────────────');
{
    // 24 felter i drift står som `text_single_line`. Uden normaliseringen ville
    // --diff melde falsk drift mellem to instanser der er enige.
    ok(normType('text_single_line') === normType('text-single-line'),
        'underscores og bindestreger er samme type');
    ok(normType('Number-Decimal') === 'number-decimal', 'og store bogstaver tæller ikke');
    ok(normType('text-single-line') !== normType('text-multi-line'),
        'men to FORSKELLIGE typer er stadig forskellige');
}

console.log('\n── Sikkerhedsgreb ────────────────────────────────────────');
{
    const kør = (args) => {
        try {
            execSync(`node scripts/ensure-grocy-userfields.js ${args} 2>&1`, { cwd: ROOT });
            return { code: 0, ud: '' };
        } catch (e) { return { code: e.status, ud: (e.stdout || '').toString() + (e.stderr || '').toString() }; }
    };
    let r = kør('');
    ok(r.code === 2 && /--location/.test(r.ud),
        'uden --location nægter scriptet at gætte hvilken instans: ' + r.ud.trim().slice(0, 80));
    r = kør('--diff hq,test --apply');
    ok(r.code === 2 && /read-only/.test(r.ud), '--diff kan ikke kombineres med --apply');
    r = kør('--diff hq');
    ok(r.code === 2 && /to lokationer/.test(r.ud), '--diff kræver præcis to lokationer');
}

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' PASS · ' + fail + ' FAIL\x1b[0m\n');
process.exit(fail ? 1 : 0);
