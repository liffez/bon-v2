// scripts/normalize-bon-line-categories.js
//
// Normaliserer historiske bare-kategorinavne i bon_lines til Grocy's
// kanoniske navne, så kategorier udelukkende kommer fra Grocy.
//
// Problemet: gamle/importerede bons har bare-varianter ("Slider", "Salat",
// "Emballage", "Drikke", "Kager") mens nye bons fra Grocy bruger de
// nummererede navne ("04 Slider", "02 Salat", "06 Emballage", ...).
// Det tvinger settings.unit_count_categories til at indeholde dubletter
// ("04 Slider" OG "Slider") for at tælle korrekt.
//
// Dette script:
//   1. Henter Grocy's kategorier LIVE (grocyAdapter.getRecipes) — kilden til sandhed.
//   2. Udleder mapping bare→kanonisk ved at strippe "NN "-præfiks
//      ("04 Slider" ⇒ bare "Slider"). Mål-navne hårdkodes ALDRIG.
//   3. Opdaterer bon_lines.category fra bare-variant → kanonisk Grocy-navn.
//   4. Rydder settings.unit_count_categories op til ren kanonisk form (dedup).
//
// Bare-varianter UDEN en matchende Grocy-kategori røres ikke (fx "Tilbehør",
// "lunch", "Frugt", "x-Levering", "x- Service").
//
// Brug:
//   node --experimental-sqlite scripts/normalize-bon-line-categories.js          # dry-run
//   node --experimental-sqlite scripts/normalize-bon-line-categories.js --apply  # skriv
//
// Tager backup af data/bon.db før --apply.
// KØR DETTE FØR backfill-total-units.js så total_units beregnes på rene kategorier.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { openDb, transaction } = require('../db/compat');
const { runMigrations } = require('../db/migrate');
const grocy = require('../services/grocyAdapter');

const args = process.argv.slice(2);
const apply = args.includes('--apply');

// Forretningsregel-overrides: historiske bare-navne der IKKE kan udledes via
// nummer-strip (kategorien findes ikke længere i Grocy), men hvor driften ved
// hvad de hører til. Nøgle = bare-navn (lowercase), værdi = mål-kategori.
// Målet VALIDERES mod Grocy ved kørsel — er det ikke en ægte Grocy-kategori,
// springes overriden over (så vi aldrig opfinder kategorier).
//   burger → 01 Sandwich: burgere var historisk en sandwich-type i Grocy.
const EXTRA_MAP = {
    'burger': '01 Sandwich',
};

const DB_PATH = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(__dirname, '..', 'data', 'bon.db');

if (!fs.existsSync(DB_PATH)) {
    console.error(`DB ikke fundet: ${DB_PATH}`);
    process.exit(1);
}

// Strip "NN " / "NN-" numerisk præfiks → bare-form. "04 Slider" ⇒ "Slider".
function bareForm(name) {
    return String(name || '').trim().replace(/^\d+\s*[-.]?\s+/, '').trim();
}

(async () => {
    console.log('Kører migrationer (idempotent)…');
    runMigrations(DB_PATH);
    const db = openDb(DB_PATH);

    // 1. Hent Grocy's kanoniske kategorier
    let recipes;
    try {
        recipes = await grocy.getRecipes();
    } catch (e) {
        console.error(`\nKunne ikke hente Grocy-kategorier: ${e.message}`);
        console.error('Scriptet kræver Grocy-adgang (GROCY_*_KEY i .env) — kør det på serveren.');
        process.exit(1);
    }

    const canonical = new Set();
    (recipes || []).forEach(r => {
        const c = (r.category || '').trim();
        if (c) canonical.add(c);
    });
    if (canonical.size === 0) {
        console.error('Grocy returnerede ingen kategorier — afbryder.');
        process.exit(1);
    }

    // 2. Byg mapping bare→kanonisk (kun entydige; kun hvor præfiks faktisk fjernes)
    const bareToCanon = new Map();   // bareLower → canonical
    const ambiguous = new Set();
    for (const canon of canonical) {
        const bare = bareForm(canon);
        if (!bare || bare === canon) continue;       // intet præfiks at strippe
        const key = bare.toLowerCase();
        if (canonical.has(bare)) continue;           // bare-form er selv en ægte Grocy-kategori
        if (bareToCanon.has(key) && bareToCanon.get(key) !== canon) { ambiguous.add(key); }
        else bareToCanon.set(key, canon);
    }
    for (const k of ambiguous) bareToCanon.delete(k);

    // Forretningsregel-overrides — kun hvis målet er en ægte Grocy-kategori.
    const overrideApplied = [];
    for (const [bareKey, target] of Object.entries(EXTRA_MAP)) {
        if (!canonical.has(target)) {
            console.warn(`  ⚠ Override "${bareKey} → ${target}" springes over: "${target}" findes ikke i Grocy.`);
            continue;
        }
        bareToCanon.set(bareKey.toLowerCase(), target);
        overrideApplied.push(`${bareKey} → ${target}`);
    }

    console.log(`\nGrocy-kategorier (${canonical.size}): ${[...canonical].sort((a, b) => a.localeCompare(b, 'da')).join(', ')}`);
    if (overrideApplied.length) console.log(`\nForretningsregel-overrides: ${overrideApplied.join(', ')}`);
    console.log(`\nUdledt mapping (bare → kanonisk):`);
    if (bareToCanon.size === 0) console.log('  (ingen — alle Grocy-kategorier er uden numerisk præfiks)');
    [...bareToCanon.entries()].forEach(([k, v]) => console.log(`  ${k} → ${v}`));
    if (ambiguous.size) console.log(`  ⚠ Tvetydige (springes over): ${[...ambiguous].join(', ')}`);

    // 3. Hvilke bon_lines-kategorier rammes?
    const distinct = db.prepare(`
        SELECT category, COUNT(*) n
        FROM bon_lines
        WHERE category IS NOT NULL AND category != ''
        GROUP BY category
    `).all();

    const plan = [];   // { from, to, n }
    for (const row of distinct) {
        const cur = row.category.trim();
        if (canonical.has(cur)) continue;            // allerede kanonisk
        const canon = bareToCanon.get(cur.toLowerCase());
        if (canon && canon !== row.category) plan.push({ from: row.category, to: canon, n: row.n });
    }

    console.log(`\n=== Planlagte ændringer i bon_lines ===`);
    if (plan.length === 0) {
        console.log('  Ingen — alle kategorier er allerede kanoniske eller har ingen Grocy-match.');
    } else {
        plan.sort((a, b) => b.n - a.n).forEach(p => console.log(`  "${p.from}" → "${p.to}"  (${p.n} linjer)`));
    }

    // Kategorier uden match (til info)
    const untouched = distinct
        .map(r => r.category.trim())
        .filter(c => !canonical.has(c) && !bareToCanon.get(c.toLowerCase()));
    if (untouched.length) console.log(`\n  Urørt (ingen Grocy-match): ${untouched.join(', ')}`);

    // 4. Plan for whitelist-oprydning
    const settingRow = db.prepare(`SELECT value FROM settings WHERE key='unit_count_categories'`).get();
    let whitelist = [];
    try { whitelist = JSON.parse(settingRow?.value || '[]'); } catch { whitelist = []; }
    if (!Array.isArray(whitelist)) whitelist = [];

    const cleanedWhitelist = [];
    for (const c of whitelist) {
        const t = String(c).trim();
        const canon = canonical.has(t) ? t : (bareToCanon.get(t.toLowerCase()) || t);
        if (!cleanedWhitelist.includes(canon)) cleanedWhitelist.push(canon);
    }
    const whitelistChanged = JSON.stringify(whitelist) !== JSON.stringify(cleanedWhitelist);
    console.log(`\n=== unit_count_categories ===`);
    console.log(`  Før:   ${JSON.stringify(whitelist)}`);
    console.log(`  Efter: ${JSON.stringify(cleanedWhitelist)}${whitelistChanged ? '' : '  (uændret)'}`);

    if (!apply) {
        console.log('\n(dry-run — kør med --apply for at skrive ændringer)');
        process.exit(0);
    }

    if (plan.length === 0 && !whitelistChanged) {
        console.log('\nIntet at gøre.');
        process.exit(0);
    }

    // Backup + skriv
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${DB_PATH}.pre-normalize-categories-${ts}`;
    fs.copyFileSync(DB_PATH, backup);
    console.log(`\nBackup: ${backup}`);

    const updLine = db.prepare(`UPDATE bon_lines SET category = ? WHERE category = ?`);
    const updSetting = db.prepare(`UPDATE settings SET value = ? WHERE key = 'unit_count_categories'`);
    let linesWritten = 0;
    transaction(db, () => {
        for (const p of plan) linesWritten += updLine.run(p.to, p.from).changes;
        if (whitelistChanged) updSetting.run(JSON.stringify(cleanedWhitelist));
    });

    console.log(`\n✅ Normaliseret ${linesWritten} bon_lines${whitelistChanged ? ' + ryddet whitelist op' : ''}.`);
    console.log('   Kør nu: node --experimental-sqlite scripts/backfill-total-units.js --apply');
})();
