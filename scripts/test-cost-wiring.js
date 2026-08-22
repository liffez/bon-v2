// scripts/test-cost-wiring.js
// ============================================================
// Overtagelsen: `getRecipes().cost_price` kommer fra `recipe_cost_cache`
// (fyldt af resolveren) i stedet for Grocys `/recipes/fulfillment`.
//
// Det er et pengetal — det havner i `bon_lines.cost_price` via VarePicker,
// i tilbud, i driftsregnskabets vareforbrug og i margin-analysen. Derfor er
// fallback-kæden testet lige så hårdt som den glade sti: en tom cache må
// ALDRIG give 0 kr, for et nul ser ud som "gratis" og ikke som "ved ikke".
//
// Kør:  node scripts/test-cost-wiring.js
// ============================================================

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

// Isoleret DB bygget af de RIGTIGE migrationer — så testen også beviser at
// migration 153 giver `recipe_cost_cache` de to nye kolonner. En håndskrevet
// kopi af skemaet ville bestå selv hvis migrationen manglede.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kostpris-'));
const dbPath = path.join(tmpDir, 'test.db');
process.env.DB_PATH = dbPath;

const { getDb } = require('../db/database');
const db = getDb();
db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('default_grocy_location_id','1')`).run();
db.prepare(`UPDATE locations SET grocy_api_url='https://eksempel/api', grocy_api_key='n' WHERE id=1`).run();
db.prepare(`DELETE FROM recipe_cost_cache`).run();

const grocy = require('../services/grocyAdapter');

// Grocy-svarene stubbes, så testen måler ledningsføringen og ikke netværket.
const RAW = [
    { id: 1, name: 'Kartoflen - Salat', base_servings: 1, desired_servings: 4,
      userfields: { sellable: '1', grupper: '02 Salat', recipeunit: 'antal', recipeunitnumber: '1' } },
    { id: 2, name: 'Uden cache-række', base_servings: 1,
      userfields: { sellable: '1', recipeunit: 'antal', recipeunitnumber: '1' } },
    { id: 3, name: 'Kun userfield', base_servings: 1,
      userfields: { sellable: '1', costprice: '42', recipeunit: 'antal', recipeunitnumber: '1' } },
];
// Stub på HTTP-laget, ikke på exporterne: `getRecipes()` kalder de
// MODUL-LOKALE funktioner, så en `grocy.getRecipesRaw = …` ville aldrig blive
// set. Det koster en test der kun beviser sig selv.
// Grocys tal: 4× for højt på recipe 1 (desired_servings), et tal på 2, intet på 3.
const SVAR = {
    '/objects/recipes': RAW,
    '/recipes/fulfillment': [{ recipe_id: 1, costs: 66.94 }, { recipe_id: 2, costs: 55 }],
};
globalThis.fetch = async (url) => {
    const sti = Object.keys(SVAR).find(k => String(url).endsWith(k));
    if (!sti) throw new Error('uventet kald: ' + url);
    return { ok: true, status: 200, json: async () => SVAR[sti] };
};

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };
const near = (a, b) => Math.abs(a - b) < 0.005;
// Falder opslaget på gulvet, skal asserten FEJLE — ikke kaste. En stak-
// udskrift skjuler hvilken regel der blev brudt.
const byName = (rs, n) => rs.find(r => r.name === n) || {};

const friske = async () => { if (grocy.clearCache) grocy.clearCache(); return grocy.getRecipes(); };

(async () => {
    console.log('\nKostpris-overtagelsen: hvor kommer tallet fra?\n');

    console.log('W1 · Tom cache → Grocys tal, tydeligt mærket');
    {
        const r = await grocy.getRecipes();
        ok(near(byName(r, 'Kartoflen - Salat').cost_price, 66.94), 'falder tilbage på Grocy før første natlige kørsel');
        ok(byName(r, 'Kartoflen - Salat').cost_price_source === 'grocy', 'kilden siger "grocy", så det ikke ligner et Bon-tal');
        ok(byName(r, 'Kun userfield').cost_price === 42, 'userfeltet er sidste udvej');
    }

    console.log('\nW2 · Med cache → Bons tal vinder');
    db.prepare(`INSERT INTO recipe_cost_cache
        (grocy_recipe_id, cost_price_excl_moms, cost_source, missing_prices_json)
        VALUES (1, 16.74, 'bon', NULL)`).run();
    {
        const r = await grocy.getRecipes();
        const k = byName(r, 'Kartoflen - Salat');
        ok(near(k.cost_price, 16.74), `16,74 og ikke Grocys 66,94 — desired_servings er ude (fik ${k.cost_price})`);
        ok(k.cost_price_source === 'bon', 'kilden siger "bon"');
        ok(k.cost_price_missing === null, 'ingen manglende priser');
    }

    console.log('\nW3 · Manglende råvarepriser følger med tallet');
    db.prepare(`INSERT INTO recipe_cost_cache
        (grocy_recipe_id, cost_price_excl_moms, cost_source, missing_prices_json)
        VALUES (2, 12.00, 'bon', '["karry","gurkemeje"]')`).run();
    {
        const r = byName(await grocy.getRecipes(), 'Uden cache-række');
        ok(Array.isArray(r.cost_price_missing) && r.cost_price_missing.length === 2,
           'de to varer eksponeres — et for lavt tal kan forklares');
        ok(r.cost_price_missing?.includes('karry'), 'og de er navngivet');
    }

    console.log('\nW4 · En cache-række på 0 må ikke se ud som gratis');
    // Vigtigste fald: hvis resolveren intet kunne regne, skal kilden afsløre
    // det. Ellers er "0 kr" og "gratis" det samme på skærmen.
    db.prepare(`INSERT INTO recipe_cost_cache
        (grocy_recipe_id, cost_price_excl_moms, cost_source) VALUES (3, 0, 'ukendt')`).run();
    {
        const r = byName(await grocy.getRecipes(), 'Kun userfield');
        ok(r.cost_price === 0 && r.cost_price_source === 'ukendt',
           'kilden siger "ukendt", så visningen kan skelne det fra 0 kr');
    }

    console.log('\nW5 · Uden tabellen overhovedet opfører alt sig som før');
    db.exec('DROP TABLE recipe_cost_cache');
    {
        const r = await grocy.getRecipes();
        ok(near(byName(r, 'Kartoflen - Salat').cost_price, 66.94), 'Grocys tal igen — migration 153 ikke kørt endnu');
        ok(byName(r, 'Kartoflen - Salat').cost_price_source === 'grocy', 'og mærket derefter');
    }

    console.log(`\n${pass} PASS · ${fail} FAIL\n`);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    process.exit(fail ? 1 : 0);
})();
