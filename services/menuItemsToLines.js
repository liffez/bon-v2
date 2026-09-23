/**
 * menuItemsToLines — oversæt web-bestillingens `menu_items[]` til bon-linje-objekter.
 *
 * Web-formularen (public/embed/bestilling.html) sender kundens ret-valg som
 * `menu_items: [{ id, count }]`, hvor id typisk er `r<recipe_id>` (retter importeret
 * fra Grocy — se routes/embed.js buildMenuFromGrocy). Denne funktion mapper dem til
 * bon-linjer med snapshot af pris/kostpris/CO₂ fra Grocy for bonens priskategori.
 *
 * REN funktion — ingen DB, ingen Grocy-kald, ingen I/O — så den kan unit-testes
 * uden server. Kalderen (routes/web-orders.js) leverer opslagene og laver INSERT.
 *
 * @param {Object}  p
 * @param {Array}   p.menuItems      [{ id, count }]
 * @param {Map}     p.recipesById    Map<number, recipe> fra grocyAdapter.getRecipes()
 *                                   recipe: { id, name, category, unit, prices:{catering,festival,...}, cost_price, co2e }
 * @param {Map}     [p.menuItemsById] Map<string,{name,category}> fra menu-JSON — fallback-navne
 *                                   for retter uden Grocy-kobling (ikke-`r`-id'er)
 * @param {string}  [p.priceCategory='catering'] Bonens priskategori — festival-events
 *                                   rammer festival-prisen, ellers catering/store osv.
 * @returns {{ lines: Array, unmatched: Array }}
 *          lines: klar til INSERT i bon_lines (unit_price=null når prisen mangler → office prissætter)
 *          unmatched: [{ id, count, reason }] til logning
 */

const R_ID = /^r(\d+)$/;

function posNum(v) {
    return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : null;
}

function resolveMenuItemLines({ menuItems, recipesById, menuItemsById = new Map(), priceCategory = 'catering' } = {}) {
    const lines = [];
    const unmatched = [];
    if (!Array.isArray(menuItems)) return { lines, unmatched };

    const recipes = recipesById instanceof Map ? recipesById : new Map();
    const menuNames = menuItemsById instanceof Map ? menuItemsById : new Map();
    const cat = priceCategory || 'catering';

    for (const raw of menuItems) {
        const id = (raw && raw.id != null) ? String(raw.id) : '';
        const count = Number(raw && raw.count);
        if (!id || !Number.isFinite(count) || count <= 0) continue;

        const m = R_ID.exec(id);
        const recipe = m ? recipes.get(Number(m[1])) : null;

        if (recipe) {
            // Pris for bonens priskategori. 0/uset i Grocy → prisløs linje (office prissætter)
            // frem for en misvisende 0 kr.
            const price = recipe.prices ? posNum(recipe.prices[cat]) : null;
            lines.push({
                grocy_recipe_id: recipe.id,
                product_name: String(recipe.name || '').trim() || `Opskrift ${recipe.id}`,
                category: recipe.category || null,
                quantity: count,
                unit: recipe.unit || 'stk',
                unit_price: price,
                cost_price: posNum(recipe.cost_price),
                co2e: posNum(recipe.co2e),
            });
            continue;
        }

        // Ikke-Grocy-koblet (manuelt tilføjet menu-item): brug navn fra menuen hvis
        // muligt, ellers marker som unmatched. Prisløs — office prissætter.
        const menuItem = menuNames.get(id);
        if (menuItem && String(menuItem.name || '').trim()) {
            lines.push({
                grocy_recipe_id: null,
                product_name: String(menuItem.name).trim(),
                category: menuItem.category || null,
                quantity: count,
                unit: 'stk',
                unit_price: null,
                cost_price: null,
                co2e: null,
            });
        } else {
            unmatched.push({ id, count, reason: m ? 'recipe_not_found' : 'no_grocy_link_and_no_menu_name' });
        }
    }

    return { lines, unmatched };
}

/**
 * chipItemsFromWishes — kost-knapperne i formularen ("🌾 Glutenfri") skriver kun
 * en tekstlinje i kundeønskerne (`Glutenfri: 2`). Nogle af dem svarer til en vare
 * der skal på bonen (en glutenfri bolle). Denne funktion finder de linjer og
 * oversætter dem til menu_items-form, så de går gennem samme opslag som menuvalget.
 *
 * Teksten er kilden, ikke knap-klikket: kunden kan rette tallet i hånden efter
 * klikket, og det rettede tal er det hun mener.
 *
 * @param {string} wishes       kundens fritekst
 * @param {Object} chipRecipes  { "Glutenfri": 75, ... } — præfiks → Grocy recipe_id
 * @returns {Array<{id,count}>}
 */
function chipItemsFromWishes(wishes, chipRecipes) {
    const out = [];
    if (typeof wishes !== 'string' || !wishes.trim()) return out;
    if (!chipRecipes || typeof chipRecipes !== 'object' || Array.isArray(chipRecipes)) return out;
    for (const [prefix, rid] of Object.entries(chipRecipes)) {
        const recipeId = Number(rid);
        if (!prefix || !Number.isInteger(recipeId) || recipeId <= 0) continue;
        const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Kun linjer der STARTER med præfikset og kun bærer et tal — "Glutenfri: 2".
        // "Glutenfri: den ene uden ost" er en besked, ikke et antal, og tolkes ikke.
        const re = new RegExp(`(?:^|\\n)[ \\t]*${esc}[ \\t]*:[ \\t]*(\\d+)[ \\t]*(?=\\n|$)`, 'i');
        const m = re.exec(wishes);
        const count = m ? parseInt(m[1], 10) : 0;
        if (count > 0) out.push({ id: `r${recipeId}`, count });
    }
    return out;
}

module.exports = { resolveMenuItemLines, chipItemsFromWishes };
