// scripts/backfill-geocode.js
// ==========================================
// Geokoder addresses uden koordinater via DAWA.
//
// Routing (Spor 2) kræver lat/lon på leveringsadresser. Nye adresser
// geokodes automatisk (fire-and-forget i routes/addresses.js), men
// v1-synkede adresser har typisk lat/lon = NULL. Dette script fylder dem.
//
// Køres én gang før Spor 2 går live — og må gerne køres igen senere
// (idempotent: rører kun rækker hvor lat ELLER lon mangler, overskriver
// aldrig eksisterende coords).
//
// Brug:
//   node --experimental-sqlite scripts/backfill-geocode.js           (dry-run)
//   node --experimental-sqlite scripts/backfill-geocode.js --apply   (skriver)
//
// Spec: docs/delivery/CLAUDE_DELIVERY_SPOR2.md sektion 3.
// ==========================================

const path = require('path');
const { openDb } = require('../db/compat');
const { geocodeRaw, DawaError } = require('../services/geocode');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/bon.db');
const APPLY = process.argv.includes('--apply');
const RATE_MS = 200;   // ~5 adresser/s — venligt mod DAWA (hver adresse kan
                       // lave op til 4 sekventielle kald: struktureret, q,
                       // datavask-vask + datavask-mini)

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function addrLabel(a) {
    return `#${a.id} ${[a.street_name, a.street_nr].filter(Boolean).join(' ')}`
        + `, ${[a.postal_code, a.city].filter(Boolean).join(' ')}`.trimEnd();
}

async function main() {
    const db = openDb(DB_PATH);

    const rows = db.prepare(`
        SELECT id, street_name, street_nr, postal_code, city
        FROM addresses
        WHERE lat IS NULL OR lon IS NULL
        ORDER BY id
    `).all();

    console.log(`${rows.length} adresse(r) uden koordinater.`);
    console.log(APPLY
        ? 'Mode: APPLY — coords skrives til addresses-tabellen.'
        : 'Mode: DRY-RUN — intet skrives. Kør med --apply for at skrive.');

    if (rows.length === 0) {
        console.log('Intet at gøre.');
        return;
    }
    console.log('');

    let ok = 0;
    const noMatch = [];     // DAWA nåede frem, men fandt ingen adresse
    const throttled = [];   // DAWA blokerede/strubede os (selv efter retries)

    for (let i = 0; i < rows.length; i++) {
        const addr = rows[i];
        let coords = null;
        let recorded = false;
        try {
            coords = await geocodeRaw({
                street: addr.street_name,
                nr: addr.street_nr,
                zip: addr.postal_code,
                city: addr.city
            });
        } catch (e) {
            if (e instanceof DawaError && e.throttled) throttled.push(addrLabel(addr));
            else noMatch.push(addrLabel(addr));
            recorded = true;
            coords = null;
        }

        if (coords) {
            ok++;
            if (APPLY) {
                db.prepare('UPDATE addresses SET lat = ?, lon = ? WHERE id = ?')
                    .run(coords.lat, coords.lon, addr.id);
            }
        } else if (!recorded) {
            // returnerede null uden exception = ægte no-match
            noMatch.push(addrLabel(addr));
        }

        if ((i + 1) % 25 === 0 || i === rows.length - 1) {
            process.stdout.write(
                `\r  ${i + 1}/${rows.length} behandlet — ${ok} geokodet, ${noMatch.length} uden match, ${throttled.length} blokeret`
            );
        }
        await sleep(RATE_MS);
    }

    console.log('\n');

    if (throttled.length) {
        console.log(`⚠ ${throttled.length} adresse(r) blev BLOKERET af DAWA (rate-limit/throttling) selv efter retries.`);
        console.log('  Det er ikke et dataproblem — DAWA struber serverens IP. Vent et par minutter');
        console.log('  og kør scriptet igen (det er idempotent og fortsætter hvor det slap).');
        console.log('');
    }
    if (noMatch.length) {
        console.log(`${noMatch.length} adresse(r) kunne ikke matches (ufuldstændige/ukendte adresser):`);
        for (const f of noMatch) console.log('  ✗ ' + f);
        console.log('');
    }
    console.log(`Færdig: ${ok} geokodet, ${noMatch.length} uden match, ${throttled.length} blokeret.`);
    if (!APPLY && ok > 0) {
        console.log('Dette var en dry-run — kør med --apply for at skrive coords.');
    }
}

main().catch(err => {
    console.error('Fejl:', err.message);
    process.exit(1);
});
