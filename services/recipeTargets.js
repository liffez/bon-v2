/**
 * Målvægt — en norm pr. Grocy-kategori, og en afvigelse pr. opskrift.
 *
 * Spec: `docs/CLAUDE_OPSKRIFT_DESIGNER.md` §10.3.
 *
 * Reglen bor her og ikke i routeren, fordi den både skal kunne læses (når
 * editoren åbner en opskrift) og skrives (når den gemmes) — og fordi den så
 * kan efterprøves uden at starte en server.
 */


/**
 * «Hvad sigter vi på at en sandwich vejer» er en norm for en SLAGS mad, ikke
 * en egenskab ved én opskrift — derfor bor den pr. Grocy-kategori, samme sted
 * som DB%-målet (migration 068/187). En enkelt ret må gerne afvige, og kun
 * afvigelsen gemmes: ændrer normen sig, følger resten med af sig selv.
 *
 * Grocy har intet felt der kan bære et gram-tal, og normen hører alligevel
 * ikke hjemme i opskriften (spec §2) — derfor Bon.
 *
 * `source` siger hvor tallet kommer fra, så skærmen kan vise en norm som en
 * hjælpetekst og en afvigelse som noget der ER sat. De to må ikke se ens ud.
 */
function målvægtFor(db, recipeId, gruppe) {
    const egen = (recipeId != null && Number.isFinite(Number(recipeId)))
        ? db.prepare('SELECT target_weight_g FROM recipe_target_weights WHERE recipe_id = ?')
             .get(Number(recipeId)) : null;
    const norm = gruppe
        ? db.prepare('SELECT target_weight_g FROM recipe_db_targets WHERE category = ?')
             .get(String(gruppe)) : null;
    const normTal = (norm && norm.target_weight_g != null) ? norm.target_weight_g : null;
    const egetTal = (egen && egen.target_weight_g != null) ? egen.target_weight_g : null;
    return {
        target_weight_g: egetTal != null ? egetTal : normTal,
        target_weight_source: egetTal != null ? 'recipe' : (normTal != null ? 'category' : null),
        target_weight_category_g: normTal,
    };
}

/**
 * Gem målvægten — men kun som AFVIGELSE.
 *
 * Er tallet det samme som kategoriens norm (eller ryddet), fjernes rækken:
 * ellers ville en senere ændring af normen ikke slå igennem, og opskriften
 * ville stå med et tal ingen huskede at have sat.
 */
function gemMålvægt(db, recipeId, gruppe, værdi, userId) {
    if (recipeId == null || !Number.isFinite(Number(recipeId))) return;
    const rid = Number(recipeId);
    const norm = målvægtFor(db, null, gruppe).target_weight_category_g;
    const tal = (værdi === null || værdi === undefined || værdi === '')
        ? null : Number(String(værdi).replace(',', '.'));
    const gyldig = Number.isFinite(tal) && tal > 0;

    if (!gyldig || (norm != null && Math.abs(tal - norm) < 0.5)) {
        db.prepare('DELETE FROM recipe_target_weights WHERE recipe_id = ?').run(rid);
        return;
    }
    db.prepare(`
        INSERT INTO recipe_target_weights (recipe_id, target_weight_g, updated_at, updated_by_user_id)
        VALUES (?, ?, CURRENT_TIMESTAMP, ?)
        ON CONFLICT(recipe_id) DO UPDATE SET
            target_weight_g = excluded.target_weight_g,
            updated_at = CURRENT_TIMESTAMP,
            updated_by_user_id = excluded.updated_by_user_id
    `).run(rid, tal, userId || null);
}

module.exports = { målvægtFor, gemMålvægt };
