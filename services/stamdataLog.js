/**
 * services/stamdataLog.js — spor på stamdata-ændringer (#666)
 * ════════════════════════════════════════════════════════════
 * Lageroversigtens ✎-dialog, optællingens ⋯-menu og "Opret produkt" skrev
 * direkte til Grocy. Der blev ikke skrevet en linje i Bon. Ændrede nogen en
 * vares placering, varegruppe eller aktiv-status, kunne man bagefter ikke se
 * hvem eller hvornår. Grocy har sin egen log, men det er ikke dér nogen
 * kigger, og den kender kun API-nøglen, ikke hvem der sad ved skærmen.
 *
 * Eksemplet der gør det konkret: «kål» blev sat inaktiv med optællingens
 * "Varen findes ikke mere". Dagen efter fik 13 bons `partial`, og det tog
 * tid at finde ud af at det var en stamdata-ændring, fordi intet i Bon sagde
 * det (#645).
 *
 * Det er forudsætningen for #667 (ret enheder fra Bon), hvor det bliver muligt
 * at skifte en vares lager-enhed. Det ændrer betydningen af al eksisterende
 * beholdning, og en sådan ændring skal kunne ses bagefter.
 *
 * TRE REGLER:
 *
 *   1. Brugeren kommer fra SESSIONEN, aldrig fra request-body (jf. Patch D og
 *      #316). Sporet er det eneste der peger på et menneske, så en afsender
 *      må ikke kunne skrive en anden ind.
 *
 *   2. Observationer logges IKKE, kun beslutninger. `LastCheckedAt` skrives ved
 *      hver optælling og hvert Gem (#613). Logges den, drukner sporet i støj og
 *      bliver ulæseligt — og så er vi tilbage ved Grocys egen log, som ingen
 *      læser.
 *
 *   3. Et spor der fejler må ikke vælte den ændring det skulle spore, men det
 *      må heller ikke fejle i stilhed. Det ville være præcis den fejlklasse
 *      #666 findes for (#305, #319). Kalderen får fejlen tilbage og sender den
 *      med i svaret.
 *
 * Ændringer lavet uden om Bon — i Grocys eget UI — ser vi ikke, og sporet
 * påstår ikke at det kan. Maskinernes egne skrivninger (CO₂-motoren,
 * varemodtagelsens stempling) går uden om ruterne og logges heller ikke. De
 * er ikke beslutninger et menneske har truffet.
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const { logChange } = require('../db/helpers');

/** Den entitet sporet hænger på. Grocy-produktets id, ikke et Bon-id. */
const ENTITY = 'grocy_product';

/**
 * Observationer, ikke beslutninger. De skrives af maskiner eller ved hvert
 * tjek, og ville drukne det et menneske faktisk har besluttet.
 */
const OBSERVATIONER = new Set([
    'LastCheckedAt', 'LastCheckedUnit',     // hvert tjek (#613)
    'price_updated_at', 'supplier_price_per_kg',
]);
const OBSERVATION_PRÆFIKS = ['hk_'];         // Hørkram-scraperen

/**
 * Hvilken skærm ændringen kom fra. Det er kun en etiket: den autoriserer
 * intet og påvirker ikke hvem der står i sporet. Men den er forskellen på
 * "nogen satte kål inaktiv" og "nogen satte kål inaktiv fra optællingen",
 * og den sidste kan man handle på. Ukendte værdier kasseres.
 */
const KILDER = new Map([
    // Nøglerne er ASCII: de rejser i en HTTP-header, og et æ/ø dér overlever
    // kun hvis browser og server er enige om tegnsættet.
    ['lageroversigt',   'lageroversigten'],
    ['optaelling',      'optællingen'],
    ['opret-produkt',   'Opret produkt'],
    ['indkob',          'indkøbsindstillinger'],
    ['varemodtagelse',  'varemodtagelsen'],
    ['opskrifter',      'Opskrifter & priser'],
    ['opskrift-editor', 'opskrift-editoren'],
    ['co2',             'CO₂-vejeværktøjet'],
]);

/** Felter hvis værdi er et id. Det gemte skal være NAVNET, ellers kan ingen læse sporet. */
const OPSLAG = {
    location_id: 'locations',
    default_consume_location_id: 'locations',
    shopping_location_id: 'shopping_locations',
    product_group_id: 'product_groups',
    qu_id_stock: 'quantity_units',
    qu_id_purchase: 'quantity_units',
    qu_id_consume: 'quantity_units',
    qu_id_price: 'quantity_units',
};

function skalLogges(felt) {
    if (!felt) return false;
    if (OBSERVATIONER.has(felt)) return false;
    return !OBSERVATION_PRÆFIKS.some(p => String(felt).startsWith(p));
}

/**
 * Sammenlignelig form. Grocy svarer med tal som strenge ('1'), en tom
 * streng og null betyder begge "intet", og booleans kommer som 1/0.
 * Uden normalisering ville hvert Gem logge "Aktiv: 1 → 1".
 */
function norm(v) {
    if (v === undefined || v === null || v === '') return null;
    if (v === true) return '1';
    if (v === false) return '0';
    return String(v).trim();
}

/**
 * Hvilke af de sendte felter ændrer FAKTISK noget?
 *
 * Kun felter i `ændringer` betragtes — det er dem der blev sendt. Et felt
 * der ikke blev sendt, er ikke ændret, uanset hvad `før` siger.
 *
 * @param {object|null} før        varens værdier før skrivningen (null = ukendt)
 * @param {object}      ændringer  det der blev sendt til Grocy
 * @returns {Array<{felt, fra, til, fraUkendt}>}
 */
function forskelle(før, ændringer) {
    const ud = [];
    const kendt = før && typeof før === 'object';
    for (const felt of Object.keys(ændringer || {})) {
        if (!skalLogges(felt)) continue;
        const til = norm(ændringer[felt]);
        if (kendt) {
            const fra = norm(før[felt]);
            if (fra === til) continue;
            ud.push({ felt, fra, til, fraUkendt: false });
        } else {
            // Før-værdien kunne ikke hentes. Vi logger stadig — at ændringen
            // skete er vigtigere end hvad den erstattede — men siger det.
            ud.push({ felt, fra: null, til, fraUkendt: true });
        }
    }
    return ud;
}

/** id → navn via opslagstabellerne. Findes navnet ikke, bruges id'et — aldrig et gæt. */
function læsbar(felt, værdi, navne) {
    if (værdi === null) return null;
    const tabel = OPSLAG[felt];
    if (!tabel || !navne || !navne[tabel]) return værdi;
    const n = navne[tabel].get(String(værdi));
    return n ? n : `#${værdi}`;
}

function kildeFra(req) {
    const k = req && typeof req.get === 'function' ? req.get('X-Bon-Kilde') : null;
    return k && KILDER.has(k) ? KILDER.get(k) : null;
}

/**
 * Byg navne-opslagene. De er cachede i adapteren, så det koster ikke et kald
 * pr. ændring. Fejler et opslag, logger vi id'et i stedet for at springe
 * sporet over — et id kan man slå op, en manglende linje kan man ikke.
 */
async function hentNavne(grocy) {
    const navne = {};
    const kilder = {
        locations: grocy.getLocations,
        shopping_locations: grocy.getShoppingLocations,
        product_groups: grocy.getProductGroups,
        quantity_units: grocy.getQuantityUnits,
    };
    await Promise.all(Object.keys(kilder).map(async (k) => {
        try {
            const rækker = await kilder[k]();
            navne[k] = new Map((rækker || []).map(r => [String(r.id), r.name]));
        } catch (err) {
            navne[k] = null;
        }
    }));
    return navne;
}

/**
 * Skriv én linje pr. ændret felt.
 *
 * @returns {{logget:number}}  hvor mange linjer der blev skrevet
 * @throws  hvis skrivningen til changelog fejler — kalderen fanger og siger det
 */
function skriv({ productId, ændret, userId, kilde, navne, handling = 'update', notat = null }) {
    let logget = 0;
    for (const f of ændret) {
        logChange({
            entityType: ENTITY,
            entityId: Number(productId),
            action: handling,
            fieldName: f.felt,
            oldValue: læsbar(f.felt, f.fra, navne),
            newValue: læsbar(f.felt, f.til, navne),
            userId: userId ?? null,
            notes: [
                notat,
                kilde ? `fra ${kilde}` : null,
                f.fraUkendt ? 'før-værdien kunne ikke hentes' : null,
            ].filter(Boolean).join(' · ') || null,
        });
        logget++;
    }
    return { logget };
}

/* ══════════════════════════════════════════════════════════════
   Opskrifter (#683)
   ══════════════════════════════════════════════════════════════
   Produktsporet ovenfor dækker `PUT /products/:id` og dets userfields.
   Opskrifterne skrives et andet sted — `services/recipeWriter.js` — og
   efterlod indtil nu intet spor overhovedet.

   Det er ikke symmetri for symmetriens skyld. UDBYTTET (`recipeunitnumber`)
   er divisoren i kostprisen for den vare opskriften producerer:

       unitCost = opskriftens kostpris / yieldInStockUnits(...)   (recipeCost.js)

   Ændres det, flytter kostprisen sig på hver eneste ret der bruger varen —
   og lagertrækket trækker en anden mængde. #680 er historien om at netop
   det felt blev overskrevet på otte opskrifter af et Gem der ikke bad om
   det, og at ingen kunne se det bagefter.

   HVORFOR SPORET SKRIVES I RUTEN, IKKE I WRITEREN
   `writeRecipe` er delt med importen, og importen logger i `import_plan_item`
   (se writerens eget hoved). Writeren skal derfor ikke vælge log — den
   returnerer sin `plan`, og hver kalder skriver sit eget spor.

   Reglerne fra produktsporet gælder uændret: brugeren fra sessionen, log kun
   efter en vellykket skrivning, og et spor der fejler vælter ikke det det
   skulle spore — men det siges højt.
   ══════════════════════════════════════════════════════════════ */

/** Grocys opskrift-id, ikke et Bon-id. */
const ENTITY_RECIPE = 'grocy_recipe';

/** Hvor meget af en fri tekst der gemmes. Changeloggen skal kunne læses. */
const TEKST_MAX = 180;

/**
 * Fremgangsmåden er HTML og kan være kilobytes. Rå i changeloggen ville den
 * gøre historikken ulæselig — præcis dét `_clipChangelogValue` findes for i
 * bon-modalen. Men den må ikke udelades: #683's dyreste fund var at et Gem
 * SLETTEDE fem linjers fremgangsmåde, og uden før-værdien kan man ikke se det.
 * Derfor: tags væk, afkortet, men bevaret.
 */
function kortTekst(v) {
    if (v === null || v === undefined) return null;
    const ren = String(v)
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<\/p>/gi, ' ')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!ren) return null;
    return ren.length > TEKST_MAX ? ren.slice(0, TEKST_MAX) + '…' : ren;
}

/** Læsbart tal: 1.1 → «1,1», og aldrig «1.1000000001». */
function tal(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(',', '.'));
    if (!Number.isFinite(n)) return String(v);
    return String(Math.round(n * 1e6) / 1e6).replace('.', ',');
}

/**
 * Felterne på opskriften, oversat fra `diffRecipe`s plan.
 *
 * Planen bærer KUN det der ændrer sig (#680's værn), så der er intet at
 * filtrere: står et felt i planen, blev det skrevet.
 *
 * @param plan   fra shared/recipe_diff.js
 * @param orig   kladden som den var (null for en ny opskrift)
 * @param navne  { products: Map(id → navn) } til opslag af produceret vare
 */
function opskriftFelter(plan, orig, navne) {
    const o = orig || {};
    const oy = o.yield || {};
    const ud = [];
    const p = plan.recipe || {};
    const u = plan.userfields || {};
    const vare = (id) => {
        if (id === null || id === undefined || id === '') return null;
        const m = navne && navne.products;
        const n = m ? m.get(String(id)) : null;
        return n || `#${id}`;
    };

    if ('name' in p)           ud.push({ felt: 'name', fra: o.name ?? null, til: p.name });
    if ('base_servings' in p)  ud.push({ felt: 'base_servings', fra: tal(o.base_servings), til: tal(p.base_servings) });
    if ('product_id' in p)     ud.push({ felt: 'product_id', fra: vare(oy.product_id), til: vare(p.product_id) });
    if ('description' in p)    ud.push({ felt: 'description', fra: kortTekst(o.description), til: kortTekst(p.description) });
    if ('grupper' in u)        ud.push({ felt: 'grupper', fra: o.group || null, til: u.grupper || null });
    if ('recipeunitnumber' in u) ud.push({ felt: 'recipeunitnumber', fra: tal(oy.amount), til: tal(u.recipeunitnumber) });
    if ('recipeunit' in u)     ud.push({ felt: 'recipeunit', fra: oy.unit || null, til: u.recipeunit || null });

    return ud;
}

/**
 * Linjerne. Én changelog-linje pr. ingrediens eller underopskrift der flytter
 * sig, med NAVN og mængde — ikke et id og et antal.
 *
 * «Ingredienser: 1 ændret» er ikke til at bruge til noget når man bagefter
 * spørger hvorfor kostprisen flyttede sig. «Rødløg: 0,5 → 0,8» er.
 *
 * Nye varer har intet produkt-id endnu (de oprettes af writeren), så de
 * kendes på deres navn fra `plan.newProducts`.
 */
function opskriftLinjer(plan, orig, navne) {
    const ud = [];
    const linjer = (orig && orig.lines) || [];
    const vedId = new Map(linjer.map(l => [String(l.id), l]));
    const pnavn = (id) => {
        const m = navne && navne.products;
        const n = (m && id != null) ? m.get(String(id)) : null;
        return n || (id == null ? 'ukendt vare' : `vare #${id}`);
    };
    const rnavn = (id) => {
        const m = navne && navne.recipes;
        const n = (m && id != null) ? m.get(String(id)) : null;
        return n || (id == null ? 'ukendt opskrift' : `opskrift #${id}`);
    };
    const nyVare = new Map((plan.newProducts || []).map(np => [String(np.key), np.name]));

    for (const p of (plan.posPost || [])) {
        const navn = p._newProductKey ? (nyVare.get(String(p._newProductKey)) || 'ny vare')
                                      : pnavn(p.product_id);
        ud.push({ felt: 'ingrediens', fra: null, til: `${navn} · ${tal(p.amount)}` });
    }
    for (const p of (plan.posPut || [])) {
        const g = vedId.get(String(p.id));
        const navn = pnavn(('product_id' in p.body) ? p.body.product_id : (g && g.product_id));
        const fraNavn = g ? pnavn(g.product_id) : navn;
        const fra = g ? `${fraNavn} · ${tal(g.amount)}` : null;
        const tilMængde = ('amount' in p.body) ? p.body.amount : (g && g.amount);
        ud.push({ felt: 'ingrediens', fra, til: `${navn} · ${tal(tilMængde)}` });
    }
    for (const id of (plan.posDelete || [])) {
        const g = vedId.get(String(id));
        ud.push({ felt: 'ingrediens', fra: g ? `${pnavn(g.product_id)} · ${tal(g.amount)}` : `linje #${id}`, til: null });
    }

    for (const n of (plan.nestPost || [])) {
        ud.push({ felt: 'underopskrift', fra: null, til: `${rnavn(n.includes_recipe_id)} · ${tal(n.servings)}` });
    }
    for (const n of (plan.nestPut || [])) {
        const g = vedId.get(String(n.id));
        ud.push({
            felt: 'underopskrift',
            fra: g ? `${rnavn(g.includes_recipe_id)} · ${tal(g.servings)}` : null,
            til: `${rnavn(n.body.includes_recipe_id)} · ${tal(n.body.servings)}`,
        });
    }
    for (const id of (plan.nestDelete || [])) {
        const g = vedId.get(String(id));
        ud.push({ felt: 'underopskrift', fra: g ? `${rnavn(g.includes_recipe_id)} · ${tal(g.servings)}` : `linje #${id}`, til: null });
    }

    return ud;
}

/** Navne til opslag. Cachet i adapteren, så det koster ikke et kald pr. gem. */
async function hentOpskriftNavne(grocy) {
    const navne = {};
    const kilder = { products: grocy.getProducts, recipes: grocy.getRecipesRaw };
    await Promise.all(Object.keys(kilder).map(async (k) => {
        try {
            const rækker = await kilder[k]();
            navne[k] = new Map((rækker || []).map(r => [String(r.id), r.name]));
        } catch (err) {
            navne[k] = null;
        }
    }));
    return navne;
}

/**
 * Skriv sporet for ét gem.
 *
 * @returns {{logget:number}}
 * @throws  hvis changelog-skrivningen fejler — kalderen fanger og siger det
 */
function skrivOpskrift({ recipeId, ændret, userId, kilde, handling = 'update', notat = null }) {
    let logget = 0;
    for (const f of ændret) {
        logChange({
            entityType: ENTITY_RECIPE,
            entityId: Number(recipeId),
            action: handling,
            fieldName: f.felt,
            oldValue: f.fra === undefined ? null : f.fra,
            newValue: f.til === undefined ? null : f.til,
            userId: userId ?? null,
            notes: [notat, kilde ? `fra ${kilde}` : null].filter(Boolean).join(' · ') || null,
        });
        logget++;
    }
    return { logget };
}

module.exports = {
    ENTITY, OBSERVATIONER, KILDER, OPSLAG,
    skalLogges, norm, forskelle, læsbar, kildeFra, hentNavne, skriv,
    // Opskrifter (#683)
    ENTITY_RECIPE, TEKST_MAX, kortTekst, tal,
    opskriftFelter, opskriftLinjer, hentOpskriftNavne, skrivOpskrift,
};
