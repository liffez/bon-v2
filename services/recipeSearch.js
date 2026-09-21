// services/recipeSearch.js
// ==========================================
// Ét søgefelt, tre slags træf (designer-spec §6.1).
//
// Brugeren vælger ALDRIG mellem "ingrediens" og "underopskrift". Systemet
// afgør det efter #270-reglen: *har underopskriften en vare, så brug varen.*
// Derfor bor valget her og ikke i browseren — det er den samme regel
// `productionTypeOf` (#329) og `buildProducedByIndex` (#558) bygger på, og
// tre kopier af den ville skride fra hinanden præcis som `_buildMailVars` gjorde.
//
// | Gruppe          | Ved valg                                    |
// |-----------------|---------------------------------------------|
// | varer           | almindelig linje                            |
// | halvfabrikata   | linje på VAREN, badge HALVFABRIKAT          |
// | nestings        | nesting, badge NESTING                      |
// | blokeret        | vises med en grund, kan ikke vælges         |
//
// ⚠️ `blokeret` er ikke pynt. En opskrift man ikke kan bruge skal SIGE hvorfor;
// forsvinder den bare fra listen, leder man efter den igen i morgen.
// ==========================================

const { productionTypeOf } = require('./ingredientResolver');

/** Højst så mange pr. gruppe — listen skal kunne skimmes, ikke scrolles. */
const MAX_PR_GRUPPE = 10;

/** Aktiv i Grocys forstand: feltet kan mangle, komme som '1'/1 eller '0'/0. */
function erAktiv(p) {
    if (!p) return false;
    if (p.active === undefined || p.active === null || p.active === '') return true;
    return String(p.active) === '1';
}

function normaliser(s) {
    return String(s == null ? '' : s).toLowerCase().trim();
}

/**
 * Hvilke opskrifter afhænger (transitivt) af `recipeId`?
 *
 * En af DEM må ikke lægges ind i den, for så regner kostprisen og lagertrækket
 * i ring. Begge veje tæller: en nesting ER en afhængighed, og det samme er en
 * varelinje hvis den vare produceres af en opskrift — `recipeCost.compute`
 * rekurserer gennem `producedBy` præcis som gennem nestings.
 *
 * `compute` har sit eget cyklusværn (stack), så et kredsløb giver 0 frem for
 * en stak-overflow. Men et tavst 0 i en kostpris er værre end en søgning der
 * lader være med at tilbyde det.
 */
function afhaengerAf(recipeId, ctx) {
    const maal = Number(recipeId);
    const ramt = new Set();

    // producentens opskrift pr. vare — samme indeks som kostprisen bruger
    const produceres = new Map();
    for (const r of ctx.recipes) {
        const pid = Number(r.product_id);
        if (pid) produceres.set(String(pid), Number(r.id));
    }

    // Hvad bruger opskrift R direkte? (nestings + producerede varer)
    const bruger = new Map();
    for (const r of ctx.recipes) bruger.set(Number(r.id), new Set());
    for (const n of ctx.nestings) {
        const s = bruger.get(Number(n.recipe_id));
        if (s) s.add(Number(n.includes_recipe_id));
    }
    for (const p of ctx.pos) {
        const producent = produceres.get(String(p.product_id));
        const s = bruger.get(Number(p.recipe_id));
        if (s && producent && producent !== Number(p.recipe_id)) s.add(producent);
    }

    // Omvendt: hvem bruger mig? Bred søgning udad fra målet.
    const koe = [maal];
    while (koe.length) {
        const nu = koe.pop();
        for (const [rid, brugt] of bruger) {
            if (brugt.has(nu) && !ramt.has(rid)) { ramt.add(rid); koe.push(rid); }
        }
    }
    return ramt;
}

/**
 * Søg varer og opskrifter i ét.
 *
 * @param q       søgeord (mindst 1 tegn — ellers tomt svar, ikke hele kataloget)
 * @param data    { recipes, pos, nestings, products, units }
 * @param opts    { excludeRecipeId } — opskriften man står i kan ikke vælges
 * @returns { q, varer, halvfabrikata, nestings, blokeret, nyVare }
 */
function searchTargets(q, data, opts = {}) {
    const naal = normaliser(q);
    const tom = { q: String(q == null ? '' : q), varer: [], halvfabrikata: [],
                  nestings: [], blokeret: [], nyVare: null };
    if (naal.length < 1) return tom;

    const recipes = data.recipes || [];
    const products = data.products || [];
    const enhedNavn = new Map((data.units || []).map(u => [Number(u.id), u.name_short || u.name]));
    const varerById = new Map(products.map(p => [String(p.id), p]));

    const egetId = opts.excludeRecipeId == null ? null : Number(opts.excludeRecipeId);
    const forbudt = egetId == null ? new Set()
        : afhaengerAf(egetId, { recipes, pos: data.pos || [], nestings: data.nestings || [] });

    const traeffer = (navn) => normaliser(navn).includes(naal);

    // Hvilke varer LAVER vi selv? Nøglen er varen, for det er den linjen
    // kommer til at pege på (#270). Bruges to steder nedenfor, så den udledes
    // én gang.
    const producentFor = new Map();     // product_id → opskrift
    for (const r of recipes) {
        if (!productionTypeOf(r)) continue;
        const pid = String(r.product_id);
        // Laveste opskrift-id vinder — samme regel som kostprisen bruger
        // (`buildProducedByIndex`, #558). Ellers kunne søgningen pege på én
        // opskrift mens prisen kom fra en anden.
        const før = producentFor.get(pid);
        if (!før || Number(r.id) < Number(før.id)) producentFor.set(pid, r);
    }

    const somHalvfabrikat = (r, vare) => ({
        kind: 'semi',                                        // linjen lægges på VAREN
        recipe_id: Number(r.id),
        product_id: Number(vare.id),
        name: r.name,
        product_name: vare.name,
        unit: enhedNavn.get(Number(vare.qu_id_stock)) || null,
        qu_id_stock: vare.qu_id_stock == null ? null : Number(vare.qu_id_stock),
        production_type: productionTypeOf(r),
    });

    // ── Varer ────────────────────────────────────────────────────────────
    // Kun aktive: en inaktiv vare kan hverken forbruges eller produceres
    // (#645 — «kål» sat inaktiv gav 13 bons `partial`). Samme regel som
    // designerens egen produkt-vælger.
    const halvfabrikata = [], nestings = [], blokeret = [];
    const semiVedVare = new Set();

    const varer = [];
    for (const p of products) {
        if (!erAktiv(p) || !traeffer(p.name)) continue;
        // En vare VI selv laver er et halvfabrikat, ikke en indkøbt vare.
        // Stod den begge steder, ville brugeren skulle vælge mellem to knapper
        // der gør præcis det samme — og #270 siger at valget er systemets.
        // Den kommer med her (og ikke kun hvis opskriftens navn matcher), så
        // varen altid kan findes på sit eget navn.
        const producent = producentFor.get(String(p.id));
        if (producent) {
            const pid = Number(producent.id);
            // ⚠️ Er producenten udelukket (det er opskriften man STÅR i) eller
            // blokeret (den ville regne i ring), må varen ikke falde tilbage
            // til at være en almindelig vare. Kostprisen rekurserer gennem
            // `producedBy` præcis som gennem nestings, så en varelinje er
            // nøjagtig lige så meget en ring — den ser bare uskyldig ud.
            const egen = egetId != null && pid === egetId;
            if (egen || forbudt.has(pid)) {
                blokeret.push({ kind: 'blocked', recipe_id: pid, name: p.name,
                    reason: egen ? 'self' : 'cycle',
                    text: egen ? 'laves af denne opskrift — den kan ikke indeholde sig selv'
                               : 'laves af en opskrift der bruger denne — ville regne i ring' });
                continue;
            }
            if (!semiVedVare.has(String(p.id))) {
                semiVedVare.add(String(p.id));
                halvfabrikata.push(somHalvfabrikat(producent, p));
            }
            continue;
        }
        if (varer.length >= MAX_PR_GRUPPE) continue;
        varer.push({
            kind: 'product',
            product_id: Number(p.id),
            name: p.name,
            unit: enhedNavn.get(Number(p.qu_id_stock)) || null,
            qu_id_stock: p.qu_id_stock == null ? null : Number(p.qu_id_stock),
            product_group_id: p.product_group_id == null ? null : Number(p.product_group_id),
        });
    }

    // ── Opskrifter: halvfabrikat, nesting eller blokeret ──────────────────
    for (const r of recipes) {
        if (!traeffer(r.name)) continue;
        const rid = Number(r.id);
        if (egetId != null && rid === egetId) continue;          // sig selv

        if (forbudt.has(rid)) {
            blokeret.push({ kind: 'blocked', recipe_id: rid, name: r.name,
                            reason: 'cycle',
                            text: 'bruger denne opskrift — ville regne i ring' });
            continue;
        }

        const type = productionTypeOf(r);                        // #329, delt regel
        if (type) {
            const vare = varerById.get(String(r.product_id));
            if (!vare || !erAktiv(vare)) {
                // Opskriften SIGER den producerer en vare, men varen er væk
                // eller slået fra. Vi nester den ikke som erstatning: #329's
                // vagt ville så trække varen alligevel og finde ingenting.
                blokeret.push({ kind: 'blocked', recipe_id: rid, name: r.name,
                                reason: 'inactive_product',
                                text: vare ? ('varen "' + vare.name + '" er slået fra i Grocy')
                                           : 'peger på en vare der ikke findes' });
                continue;
            }
            // Kan allerede være med fra vare-løkken (varens navn matchede).
            if (!semiVedVare.has(String(r.product_id))) {
                semiVedVare.add(String(r.product_id));
                halvfabrikata.push(somHalvfabrikat(r, vare));
            }
            continue;
        }

        nestings.push({
            kind: 'nesting',
            recipe_id: rid,
            name: r.name,
            base_servings: parseFloat(r.base_servings) || 1,
        });
    }

    return {
        q: String(q),
        varer,
        halvfabrikata: halvfabrikata.slice(0, MAX_PR_GRUPPE),
        nestings: nestings.slice(0, MAX_PR_GRUPPE),
        blokeret: blokeret.slice(0, MAX_PR_GRUPPE),
        // Altid tilbudt: en vare man ikke kan finde, skal kunne oprettes på stedet (§8).
        nyVare: { kind: 'new', name: String(q).trim() },
    };
}

module.exports = { searchTargets, afhaengerAf, erAktiv, MAX_PR_GRUPPE };
