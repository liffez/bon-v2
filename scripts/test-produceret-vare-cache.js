// scripts/test-produceret-vare-cache.js
// ============================================================
// Et ændret `recipes.product_id` flytter kostprisen på ALLE opskrifter, ikke
// kun på den der blev rettet.
//
// Sagen: `updateRecipe` ryddede kun DENNE opskrifts række i `recipe_cost_cache`.
// Men når en opskrift producerer en vare, kommer varens pris fremover fra
// opskriften i stedet for lagerprisen (#558) — og det rammer hver eneste
// opskrift der bruger varen. Blev kun én række ryddet, viste Opskrifter & priser
// gamle tal på alle de andre, og forskellen var usynlig.
//
// Testen rammer den ÆGTE `updateRecipe` mod en temp-DB bygget af de rigtige
// migrations; kun HTTP-laget er stubbet. Et spejl af reglen her ville kunne
// drive fra adapteren uden at én eneste assert faldt.
//
// Kør:  node --experimental-sqlite scripts/test-produceret-vare-cache.js
// ============================================================
'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const TEST_DB = path.join(os.tmpdir(), `bon-prodvare-cache-${Date.now()}.db`);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

process.env.DB_PATH  = TEST_DB;
process.env.NODE_ENV = 'test';

require('../db/migrate').runMigrations(TEST_DB);

const { getDb } = require('../db/database');
const db = getDb();

// En lokation adapteren kan finde en URL og en nøgle på.
db.prepare(`UPDATE locations SET grocy_api_url = ?, grocy_api_key = ? WHERE id = (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'default_grocy_location_id')`)
  .run('http://stub.invalid/api', 'stub-key');

// HTTP-laget stubbes — der skrives aldrig til en rigtig Grocy.
const sendt = [];
global.fetch = async (url, opts) => {
    sendt.push({ url: String(url), body: opts && opts.body });
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

const grocy = require('../services/grocyAdapter');

function seedCache() {
    db.prepare('DELETE FROM recipe_cost_cache').run();
    for (const id of [110, 27, 77]) {
        db.prepare(`INSERT INTO recipe_cost_cache (grocy_recipe_id, cost_price_excl_moms)
                    VALUES (?, 1.0)`).run(id);
    }
}
const cacheIds = () => db.prepare('SELECT grocy_recipe_id AS id FROM recipe_cost_cache ORDER BY id').all().map(r => r.id);

(async () => {
    console.log('\n── Kostpris-cachen ved et ændret product_id ──────────────');

    // Forudsætningen: uden den er hele testen indholdsløs.
    seedCache();
    ok(cacheIds().length === 3, 'tre opskrifter ligger i kostpris-cachen til at begynde med');

    // 1) En ændring der IKKE rører product_id rammer kun sin egen række.
    seedCache();
    await grocy.updateRecipe(110, { name: 'Chili Mayo 2' });
    let efter = cacheIds();
    ok(efter.length === 2 && !efter.includes(110),
        'en navneændring rydder kun opskriftens egen række (' + JSON.stringify(efter) + ')');

    // 2) Et ændret product_id rydder HELE cachen.
    seedCache();
    await grocy.updateRecipe(110, { product_id: 34 });
    efter = cacheIds();
    ok(efter.length === 0,
        'et ændret product_id rydder hele kostpris-cachen (' + JSON.stringify(efter) + ')');

    // 3) Også når varen FJERNES — prisen falder da tilbage på lagerprisen,
    //    og det flytter lige så mange opskrifter som da den blev sat.
    seedCache();
    await grocy.updateRecipe(110, { product_id: null });
    ok(cacheIds().length === 0, 'at fjerne varen rydder også hele cachen');

    // 4) product_id sammen med andre felter tæller stadig.
    seedCache();
    await grocy.updateRecipe(110, { name: 'X', product_id: 34 });
    ok(cacheIds().length === 0, 'product_id i en større body tæller også');

    // 5) Skrivningen nåede rent faktisk ud til Grocy-laget.
    ok(sendt.length === 4 && sendt.every(s => s.url.indexOf('/objects/recipes/110') !== -1),
        'alle fire skrivninger gik til /objects/recipes/110 (' + sendt.length + ')');

    console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' PASS · ' + fail + ' FAIL\x1b[0m\n');
    try { fs.unlinkSync(TEST_DB); } catch (e) { /* ryddet af sig selv */ }
    process.exit(fail ? 1 : 0);
})();
