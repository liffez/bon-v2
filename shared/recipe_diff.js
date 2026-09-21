// shared/recipe_diff.js
// ==========================================
// Hvad skal skrives for at gå fra den indlæste opskrift til kladden?
//
// HVORFOR DEN ER DELT
// Browseren skal kunne sige "Gem 3 ændringer" på knappen, og serveren skal
// skrive præcis de tre. Regnede de hver for sig, ville knappen love noget
// andet end der skete — og et Gem uden ændringer kunne holde op med at være
// gratis uden at nogen opdagede det. Dual-export som shared/recipe_yield.js
// og shared/moms.js: ét regnestykke, to sider.
//
// VÆRNET (#680, designer-spec I4)
// Et Gem uden ændringer skriver INTET. Det var ikke altid sandt: designeren
// sendte hvert felt, hver linje og hver nesting ved hvert Gem — også dem der
// ikke var rørt — og satte undervejs `recipeunitnumber` lig `base_servings`,
// så udbyttet blev ødelagt på syv opskrifter. Derfor sammenlignes der felt for
// felt mod det der faktisk stod i Grocy, og der sendes kun forskellen.
//
// FORMATET
// Både `orig` og `draft` er kladde-objektet fra services/recipeDraft.js —
// samme form importeren leverer (designer-spec §15). `orig` har id på hver
// linje; kladdens linjer uden id er nye.
// ==========================================

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.RecipeDiff = api;
})(typeof self !== 'undefined' ? self : this, function () {

    function str(v) { return v == null ? '' : String(v); }
    function text(v) { return str(v).replace(/\r\n?/g, '\n'); }

    /** Tal fra et felt der kan være tomt, en streng eller et dansk komma. */
    function optNum(v) {
        if (v == null || str(v).trim() === '') return null;
        const n = Number(str(v).replace(',', '.'));
        return Number.isFinite(n) ? n : null;
    }

    /** To tal er ens når de er det på ni decimaler — ellers ville 0,1+0,2 skrive. */
    function numEq(a, b) {
        if (a == null || b == null) return a == null && b == null;
        return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    }

    const erNesting = (l) => l && l.includes_recipe_id != null && l.includes_recipe_id !== '';

    /** Den ene nøgle en ny vare kendes på, både i kladden og i planen. */
    function nyVareNoegle(line, i) {
        const k = line.new_product && line.new_product.key;
        return k != null && k !== '' ? String(k) : 'linje-' + i;
    }

    /**
     * @param orig   kladde-objektet som Grocy har det (linjer MED id), eller null for en ny opskrift
     * @param draft  kladden som brugeren har den
     * @returns {{
     *   recipe, userfields,                    // kun ændrede felter
     *   newProducts,                           // [{key, name, qu_id_stock, ...}] — oprettes først
     *   posPost, posPut, posDelete,
     *   nestPost, nestPut, nestDelete,
     *   blockers,                              // linjer der forhindrer gem (R8.4)
     *   changeCount, isEmpty, isNew
     * }}
     */
    function diffRecipe(orig, draft) {
        const erNy = !orig;
        const o = orig || { lines: [], yield: {} };
        const oy = o.yield || {}, dy = draft.yield || {};

        const plan = {
            recipe: {}, userfields: {}, newProducts: [],
            posPost: [], posPut: [], posDelete: [],
            nestPost: [], nestPut: [], nestDelete: [],
            blockers: [], isNew: erNy,
        };

        // ── Felterne på opskriften ────────────────────────────────
        const navn = str(draft.name).trim();
        if (erNy || navn !== str(o.name).trim()) plan.recipe.name = navn;
        if (erNy || text(draft.description) !== text(o.description)) {
            plan.recipe.description = draft.description || null;
        }
        if (erNy || !numEq(optNum(draft.base_servings), optNum(o.base_servings))) {
            plan.recipe.base_servings = optNum(draft.base_servings) || 1;
        }
        // `null` rydder feltet: opskriften producerer da ingenting.
        const dProd = optNum(dy.product_id), oProd = optNum(oy.product_id);
        if (erNy ? dProd != null : !numEq(dProd, oProd)) plan.recipe.product_id = dProd;

        const uf = [
            ['grupper', str(draft.group), str(o.group)],
            ['recipeunit', str(dy.unit), str(oy.unit)],
        ];
        for (const [navnPaaFelt, ny, gammel] of uf) {
            if (erNy ? ny !== '' : ny !== gammel) plan.userfields[navnPaaFelt] = ny;
        }
        const dUd = optNum(dy.amount), oUd = optNum(oy.amount);
        if (erNy ? dUd != null : !numEq(dUd, oUd)) {
            plan.userfields.recipeunitnumber = dUd == null ? '' : String(dUd);
        }

        // ── Linjerne ──────────────────────────────────────────────
        const setPos = new Set(), setNest = new Set();

        (draft.lines || []).forEach((l, i) => {
            if (erNesting(l)) {
                const krop = {
                    includes_recipe_id: Number(l.includes_recipe_id),
                    servings: optNum(l.servings) || 0,
                };
                if (!l.id) { plan.nestPost.push(krop); return; }
                setNest.add(String(l.id));
                const g = (o.lines || []).find(x => erNesting(x) && String(x.id) === String(l.id));
                if (!g) { plan.nestPost.push(krop); return; }
                if (!numEq(optNum(l.servings), optNum(g.servings))
                    || !numEq(optNum(l.includes_recipe_id), optNum(g.includes_recipe_id))) {
                    plan.nestPut.push({ id: l.id, body: krop });
                }
                return;
            }

            // En linje der peger på en vare der ikke findes endnu. Lagerenheden
            // er det eneste ud over navn og mængde der er påkrævet — uden den
            // kan linjen ikke regnes om, og gem blokeres (R8.4 / oversættelse §3).
            if (l.new_product) {
                const key = nyVareNoegle(l, i);
                const np = l.new_product;
                if (np.qu_id_stock == null || np.qu_id_stock === '') {
                    plan.blockers.push({ key, name: str(np.name), reason: 'mangler_enhed' });
                }
                if (!plan.newProducts.some(p => p.key === key)) {
                    plan.newProducts.push(Object.assign({}, np, { key }));
                }
                plan.posPost.push({
                    _newProductKey: key,
                    amount: optNum(l.amount) || 0,
                    ingredient_group: l.section || null,
                    note: l.note || null,
                });
                return;
            }

            const krop = {
                product_id: Number(l.product_id),
                amount: optNum(l.amount) || 0,
                ingredient_group: l.section || null,
                note: l.note || null,
            };
            if (!l.id) { plan.posPost.push(krop); return; }
            setPos.add(String(l.id));
            const g = (o.lines || []).find(x => !erNesting(x) && String(x.id) === String(l.id));
            if (!g) { plan.posPost.push(krop); return; }
            const body = {};
            if (!numEq(optNum(l.product_id), optNum(g.product_id))) body.product_id = krop.product_id;
            if (!numEq(optNum(l.amount), optNum(g.amount))) body.amount = krop.amount;
            if (str(l.section) !== str(g.section)) body.ingredient_group = krop.ingredient_group;
            if (str(l.note) !== str(g.note)) body.note = krop.note;
            if (Object.keys(body).length) plan.posPut.push({ id: l.id, body });
        });

        // Det der var der, og ikke er mere.
        for (const g of (o.lines || [])) {
            if (!g.id) continue;
            if (erNesting(g)) { if (!setNest.has(String(g.id))) plan.nestDelete.push(g.id); }
            else if (!setPos.has(String(g.id))) plan.posDelete.push(g.id);
        }

        plan.changeCount =
            Object.keys(plan.recipe).length + Object.keys(plan.userfields).length +
            plan.posPost.length + plan.posPut.length + plan.posDelete.length +
            plan.nestPost.length + plan.nestPut.length + plan.nestDelete.length;
        plan.isEmpty = plan.changeCount === 0 && plan.newProducts.length === 0;
        return plan;
    }

    return { diffRecipe, optNum, numEq, str, text, nyVareNoegle };
});
