// services/deliveryBoxes.js
// ==========================================
// Hvor mange kolli buddet skal bære — ÉN regel.
//
// Kolonnen `bons.boxes` er tom på ALLE 3.288 bons i drift (målt 20-09-2026):
// der findes ingen skærm der sætter den. Alt der læste den råt fik derfor 0,
// og det var tavst — bud-popoutets {total_boxes} meldte "[mangler]" på hver
// eneste bon, og By-expressens kasse-tillæg (included_boxes 2, extra_box_cost
// 50) fyrede aldrig, så popoutet viste 154 kr hvor logistik-rækken viste 254.
//
// Tallet ligger derimod på bonnen som emballage-linjer: 444 af 509
// leverings-bons i 2026 har en transportkasse-linje, gennemsnitligt 3,3 stk.
//
// Opskrifterne UDPEGES via settings.delivery_box_recipes (migration 180) —
// de gættes ikke ud fra navnet. Et match på "%transportkasse%" ville ramme
// enhver ny vare nogen kalder noget i den retning, og en emballagevare der
// skifter navn ville tavst holde op med at tælle.
//
// Vi udleder IKKE et tal når linjerne mangler. Bonnen har da ingen kasser
// registreret, og et gæt (fx ceil(enheder / pax_per_box)) ville se ud som en
// måling. [mangler] er det ærlige svar — jf. yield-modellen: vi opfinder
// aldrig et tal.
// ==========================================

const { getDb } = require('../db/database');

let _cache = null;
let _cacheUntil = 0;

// ==========================================
// Opskrift-id'er der tæller som transportkasse.
// 60s cache, samme mønster som getUnitCountCategories.
// ==========================================
function getBoxRecipeIds() {
    const now = Date.now();
    if (_cache && now < _cacheUntil) return _cache;
    const row = getDb().prepare(`SELECT value FROM settings WHERE key='delivery_box_recipes'`).get();
    let list = [];
    if (row?.value) {
        try { list = JSON.parse(row.value); } catch { list = []; }
        if (!Array.isArray(list)) list = [];
    }
    // Kun hele, positive id'er — vrøvl i settingen må ikke blive til en
    // SQL-parameter eller en tavs forkert sammenligning.
    list = list.map(Number).filter(n => Number.isInteger(n) && n > 0);
    _cache = list;
    _cacheUntil = now + 60_000;
    return list;
}

function invalidateBoxRecipeCache() {
    _cache = null;
    _cacheUntil = 0;
}

// ==========================================
// Tæl kasser på et sæt bon-linjer.
// Ren funktion — listen sendes ind, så den kan testes uden DB.
// ==========================================
function countBoxesFromLines(lines, recipeIds) {
    if (!Array.isArray(lines) || !Array.isArray(recipeIds) || recipeIds.length === 0) return 0;
    const wanted = new Set(recipeIds.map(Number));
    let total = 0;
    for (const line of lines) {
        const rid = Number(line?.grocy_recipe_id);
        if (!Number.isFinite(rid) || !wanted.has(rid)) continue;
        const qty = Number(line.quantity);
        if (Number.isFinite(qty) && qty > 0) total += qty;
    }
    // Kolli er hele kasser. Et halvt kolli findes ikke hos buddet.
    return Math.round(total);
}

// ==========================================
// Kasse-antal for en bon fra getBon() (bærer .lines).
//
// `bons.boxes` beholder forrangen hvis nogen HAR sat den — et tal et menneske
// har skrevet vinder over en optælling. I praksis er kolonnen tom overalt.
//
// Returnerer null når intet er kendt, så kaldere kan skelne "ingen kasser
// registreret" fra "nul kasser". Et 0 i et felt til buddet er en påstand;
// [mangler] er et spørgsmål.
// ==========================================
function boxesForBon(bon, recipeIds = null) {
    if (!bon) return null;
    if (bon.boxes != null && Number(bon.boxes) > 0) return Number(bon.boxes);
    const ids = recipeIds || getBoxRecipeIds();
    const counted = countBoxesFromLines(bon.lines, ids);
    return counted > 0 ? counted : null;
}

// ==========================================
// SQL-fragment til at tælle kasser i en query der ikke har linjerne med.
// Bruges hvor en bon hentes uden sine bon_lines (rute-stop, lister).
//
//   const { sql, args } = boxCountSql('b');
//   `SELECT b.id, ${sql} AS boxes FROM bons b ...`   // args efter de øvrige
//
// Tom liste → fragmentet er konstant 0, og args er tom.
// ==========================================
function boxCountSql(bonAlias = 'b', recipeIds = null) {
    const ids = recipeIds || getBoxRecipeIds();
    if (!ids.length) return { sql: '0', args: [] };
    const placeholders = ids.map(() => '?').join(',');
    return {
        sql: `COALESCE(NULLIF(${bonAlias}.boxes, 0), (
                SELECT CAST(ROUND(COALESCE(SUM(bl.quantity), 0)) AS INTEGER)
                FROM bon_lines bl
                WHERE bl.bon_id = ${bonAlias}.id
                  AND bl.grocy_recipe_id IN (${placeholders})
              ))`,
        args: ids
    };
}

module.exports = {
    getBoxRecipeIds,
    invalidateBoxRecipeCache,
    countBoxesFromLines,
    boxesForBon,
    boxCountSql
};
