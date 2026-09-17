/**
 * services/grocyAdapter.js
 * ════════════════════════════════════════════════════════════
 * Adapter til Grocy API.
 *
 * Eksporterer funktioner der kaldes fra routes/grocy.js.
 * Henter credentials fra locations-tabellen (med .env fallback).
 * In-memory cache med 10 min TTL.
 *
 * Primært readonly — skriver kun til shopping_list.
 * ════════════════════════════════════════════════════════════
 */

const { getDb } = require('../db/database');
const { getDefaultLocationId, offsetISO } = require('../db/helpers');

/* ══════════════════════════════════════════════════════════════
   CACHE
   ══════════════════════════════════════════════════════════════ */

const _cache = new Map(); // key → { data, expires }

function getCached(key) {
    const entry = _cache.get(key);
    if (entry && entry.expires > Date.now()) return entry.data;
    return null;
}

function setCached(key, data, ttlMs = 10 * 60 * 1000) {
    _cache.set(key, { data, expires: Date.now() + ttlMs });
}

/** Ryd hele cachen (til debugging / settings-ændring) */
function clearCache() {
    _cache.clear();
}

/* ══════════════════════════════════════════════════════════════
   GROCY CONFIG
   ══════════════════════════════════════════════════════════════ */

/**
 * Hent Grocy-konfiguration for en specifik (eller standard) lokation.
 *
 * @param {number} [locationIdOverride] — hvis sat: brug denne lokation i stedet for default
 *
 * 1. Læs default_grocy_location_id fra settings → fallback: første aktive lokation
 *    (springes over hvis locationIdOverride er givet)
 * 2. Hent grocy_api_url + grocy_api_key fra locations
 * 3. Hvis api_key er tom → fallback til GROCY_<CODE>_KEY → GROCY_HQ_KEY
 */
function getGrocyConfig(locationIdOverride) {
    const db = getDb();

    // Find lokation-id
    let locationId;
    if (locationIdOverride) {
        locationId = parseInt(locationIdOverride);
    } else {
        const setting = db.prepare(`SELECT value FROM settings WHERE key = 'default_grocy_location_id'`).get();
        locationId = setting ? parseInt(setting.value) : getDefaultLocationId();
    }

    if (!locationId) {
        throw new Error('Ingen aktiv lokation fundet. Opret mindst én lokation i locations-tabellen.');
    }

    // Hent lokation
    const loc = db.prepare(`SELECT grocy_api_url, grocy_api_key, name, code FROM locations WHERE id = ?`).get(locationId);
    if (!loc) {
        throw new Error(`Lokation ${locationId} findes ikke.`);
    }

    const url = loc.grocy_api_url;
    // Fallback-kæde: locations-tabel → env pr. lokation (GROCY_<CODE>_KEY, uppercased) → env HQ
    const envKey = `GROCY_${String(loc.code).toUpperCase()}_KEY`;
    const key = loc.grocy_api_key || process.env[envKey] || process.env.GROCY_HQ_KEY || '';

    if (!url) {
        throw new Error(`Lokation "${loc.name}" mangler grocy_api_url.`);
    }
    if (!key) {
        // Nævn kun fallback'en når den er et ANDET navn — for HQ er de to ens, og
        // "hverken GROCY_HQ_KEY eller GROCY_HQ_KEY" læses som om beskeden tager fejl.
        const names = envKey === 'GROCY_HQ_KEY' ? envKey : `${envKey} eller GROCY_HQ_KEY`;
        throw new Error(`Lokation "${loc.name}" mangler grocy_api_key, og ${names} er ikke indlæst`
            + ' (står nøglen i .env, mangler kaldet formentlig --env-file=.env).');
    }

    return { url, key, locationName: loc.name };
}

/* ══════════════════════════════════════════════════════════════
   HTTP
   ══════════════════════════════════════════════════════════════ */

/**
 * Fetch fra Grocy API med autentificering.
 * @param {string} path  Sti relativt til API-rod (fx '/objects/recipes')
 */
async function grocyFetch(path) {
    const { url, key } = getGrocyConfig();

    // Fjern trailing slash fra url og leading slash fra path
    const base = url.replace(/\/+$/, '');
    const route = path.startsWith('/') ? path : '/' + path;

    const res = await fetch(base + route, {
        headers: {
            'GROCY-API-KEY': key,
            'Accept': 'application/json',
        },
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Grocy API fejl ${res.status}: ${body.slice(0, 200)}`);
    }

    return res.json();
}

/**
 * Fetch med cache-lag.
 * @param {string} cacheKey  Unik cache-nøgle
 * @param {string} path      Grocy API-sti
 */
async function cachedFetch(cacheKey, path) {
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const data = await grocyFetch(path);
    setCached(cacheKey, data);
    return data;
}

/**
 * POST til Grocy API (bruges til shopping_list).
 * @param {string} path  Sti relativt til API-rod
 * @param {Object} body  Request body
 */
async function grocyPost(path, body) {
    const { url, key } = getGrocyConfig();
    const base = url.replace(/\/+$/, '');
    const route = path.startsWith('/') ? path : '/' + path;

    const res = await fetch(base + route, {
        method: 'POST',
        headers: {
            'GROCY-API-KEY': key,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Grocy POST fejl ${res.status}: ${text.slice(0, 200)}`);
    }

    // Grocy returnerer ofte 204 No Content (ingen body)
    if (res.status === 204 || res.headers.get('content-length') === '0') {
        return {};
    }
    return res.json().catch(() => ({}));
}

/**
 * PUT til Grocy API.
 */
async function grocyPut(path, body) {
    const { url, key } = getGrocyConfig();
    const base = url.replace(/\/+$/, '');
    const route = path.startsWith('/') ? path : '/' + path;

    const res = await fetch(base + route, {
        method: 'PUT',
        headers: {
            'GROCY-API-KEY': key,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Grocy PUT fejl ${res.status}: ${text.slice(0, 200)}`);
    }

    // PUT returnerer ofte tom body
    const text = await res.text();
    return text ? JSON.parse(text) : {};
}

/**
 * DELETE fra Grocy API.
 */
async function grocyDelete(path) {
    const { url, key } = getGrocyConfig();
    const base = url.replace(/\/+$/, '');
    const route = path.startsWith('/') ? path : '/' + path;

    const res = await fetch(base + route, {
        method: 'DELETE',
        headers: {
            'GROCY-API-KEY': key,
            'Accept': 'application/json',
        },
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Grocy DELETE fejl ${res.status}: ${text.slice(0, 200)}`);
    }

    return {};
}

/* ══════════════════════════════════════════════════════════════
   RECIPE CRUD — skriver til Grocy via proxy
   ══════════════════════════════════════════════════════════════ */

/**
 * Invalider cachet kostpris for én opskrift.
 * Kaldes fra recipe-CRUD så Opskrifter & priser viewet får frisk pris
 * uden at vente på nightly refresh.
 */
function invalidateRecipeCost(recipeId) {
    // Grocys fulfillment (in-memory, 10 min TTL) ER kostpris-kilden. En opskrift-
    // redigering ændrer den, så den skal ryddes her — ellers viser composition/
    // drill-down + designerens kostpris et forældet tal indtil TTL udløber.
    _cache.delete('recipes_fulfillment');
    if (!recipeId) return;
    try {
        const db = getDb();
        db.prepare('DELETE FROM recipe_cost_cache WHERE grocy_recipe_id = ?')
          .run(Number(recipeId));
    } catch (err) {
        // Tabel findes ikke endnu (før migration 068 er kørt) — ikke fatalt
    }
}

/**
 * Slet hele recipe_cost_cache. Bruges når vi ikke kender den specifikke
 * recipe_id der ejer en ændret position (fallback for update/delete-pos
 * uden recipe_id). Næste GET /api/recipes/overview triggers fuld refresh.
 */
function invalidateAllRecipeCosts() {
    _cache.delete('recipes_fulfillment');   // se note i invalidateRecipeCost
    try {
        const db = getDb();
        db.prepare('DELETE FROM recipe_cost_cache').run();
    } catch (err) {
        /* tabel findes ikke endnu — ikke fatalt */
    }
}

/**
 * Slå recipe_id op for en position-ID via in-memory cache.
 * Returnerer null hvis cachen er kold — kaldeperson kalder så
 * invalidateAllRecipeCosts() som fallback.
 */
function _findRecipeIdForPos(posId) {
    const cached = getCached('all_recipes_pos');
    if (!cached) return null;
    const pos = cached.find(p => Number(p.id) === Number(posId));
    return pos ? Number(pos.recipe_id) : null;
}

/** Slå parent recipe_id op for en nesting-ID via cache. */
function _findRecipeIdForNesting(nestingId) {
    const cached = getCached('recipes_nestings');
    if (!cached) return null;
    const n = cached.find(x => Number(x.id) === Number(nestingId));
    return n ? Number(n.recipe_id) : null;
}

/** Opret ny opskrift */
async function createRecipe(body) {
    const result = await grocyPost('/objects/recipes', body);
    _cache.delete('recipes');
    return result;
}

/** Opdater eksisterende opskrift */
async function updateRecipe(id, body) {
    const result = await grocyPut(`/objects/recipes/${id}`, body);
    _cache.delete('recipes');
    invalidateRecipeCost(id);
    return result;
}

/** Opdater userfields på opskrift */
async function updateRecipeUserfields(id, fields) {
    const result = await grocyPut(`/userfields/recipes/${id}`, fields);
    _cache.delete('recipes');
    invalidateRecipeCost(id);
    return result;
}

/** Opret ingrediens-position */
async function createRecipePos(body) {
    const result = await grocyPost('/objects/recipes_pos', body);
    _cache.delete('all_recipes_pos');
    _cache.delete(`recipe_ing_${body.recipe_id}`);
    invalidateRecipeCost(body.recipe_id);
    return result;
}

/** Opdater ingrediens-position */
async function updateRecipePos(id, body) {
    // Slå recipe_id op FØR cache invalideres (så cachen stadig kan bruges)
    const recipeId = body.recipe_id || _findRecipeIdForPos(id);
    const result = await grocyPut(`/objects/recipes_pos/${id}`, body);
    _cache.delete('all_recipes_pos');
    if (recipeId) invalidateRecipeCost(recipeId);
    else invalidateAllRecipeCosts();
    return result;
}

/** Slet ingrediens-position */
async function deleteRecipePos(id) {
    const recipeId = _findRecipeIdForPos(id);
    const result = await grocyDelete(`/objects/recipes_pos/${id}`);
    _cache.delete('all_recipes_pos');
    if (recipeId) invalidateRecipeCost(recipeId);
    else invalidateAllRecipeCosts();
    return result;
}

/** Opret underopskrift-relation */
async function createRecipeNesting(body) {
    const result = await grocyPost('/objects/recipes_nestings', body);
    _cache.delete('recipes_nestings');
    invalidateRecipeCost(body.recipe_id);
    return result;
}

/** Opdater underopskrift-relation */
async function updateRecipeNesting(id, body) {
    const recipeId = body.recipe_id || _findRecipeIdForNesting(id);
    const result = await grocyPut(`/objects/recipes_nestings/${id}`, body);
    _cache.delete('recipes_nestings');
    if (recipeId) invalidateRecipeCost(recipeId);
    else invalidateAllRecipeCosts();
    return result;
}

/** Slet underopskrift-relation */
async function deleteRecipeNesting(id) {
    const recipeId = _findRecipeIdForNesting(id);
    const result = await grocyDelete(`/objects/recipes_nestings/${id}`);
    _cache.delete('recipes_nestings');
    if (recipeId) invalidateRecipeCost(recipeId);
    else invalidateAllRecipeCosts();
    return result;
}

/* ══════════════════════════════════════════════════════════════
   READ-FUNKTIONER
   ══════════════════════════════════════════════════════════════ */

/** Alle opskrifter (rå Grocy-data) */
function getRecipesRaw() {
    return cachedFetch('recipes', '/objects/recipes');
}

/**
 * Enhedskost pr. produkt (kr pr. LAGER-enhed, ex moms) MED ophav.
 *
 * PRISEN REGNES AF KØBSHISTORIKKEN, IKKE AF GROCYS TAL (#557)
 * Kostpris-grundlaget er et mængdevægtet snit af købsposteringer de seneste
 * `PRICE_WINDOW_DAYS` dage, læst fra `stock_log`. Reglen selv — og hvorfor
 * hverken Grocys `avg_price` eller et snit over al tid duer — står i
 * `services/recipeCost.js` ved `unitCostDetail`.
 *
 * ÉT LOG-OPSLAG PR. PRODUKT
 * `/objects/stock_log` svarer **500 uden `limit`** (hele tabellen læses ind før
 * den skæres til), så der spørges pr. produkt med filtre på. Filtrene er ikke
 * kosmetik: uden `order=…desc` returnerer Grocy de ÆLDSTE rækker først, og et
 * `limit` ville så skære de nye væk — præcis dem vi skal bruge.
 *
 * `/stock/products/:id` spørges KUN for de produkter der ingen køb har i loggen
 * overhovedet. Det er fallback-trin 3, og det er en håndfuld varer — ikke de
 * ~225 opslag reglen kostede da Grocys eget gennemsnit var ankeret.
 *
 * Lagerpostens pris fra `/objects/stock` er trin 3's FØRSTE led (ikke et
 * nødspor): den er det nyeste vi ved om varen når loggen intet siger.
 *
 * Forældre-produkter arver gennemsnittet af børnenes priser. Grocy ruller
 * børnenes LAGER op på forælderen (derfor findes makeEffectiveStock), men
 * ikke deres pris — `kål` står til 0 selvom Spidskål koster 24 og Hvidkål
 * 14,50, og kålen ligger i Frisk Grønt, som er nestet i 26 menuer.
 *
 * @param {number} concurrency  samtidige opslag (default 6)
 * @param {object} [opts]
 *   fresh       springer cachen over. Det natlige job og "Opdater priser"-
 *               knappen skal have friske tal — det er hele deres formål.
 *   productIds  prissæt kun disse produkter. Drill-down-panelet skal vise de
 *               SAMME priser som totalen, men må ikke betale for hele kataloget
 *               på en klik-sti. Delmængden hverken læser eller skriver cachen,
 *               fordi den ikke er hele svaret.
 * @returns {Promise<Map<string, object>>}  product_id → unitCostDetail()
 */
async function getProductUnitCostDetails(concurrency = 6, opts = {}) {
    const subset = Array.isArray(opts.productIds) ? opts.productIds.map(String) : null;
    if (!subset && !opts.fresh) {
        const cached = getCached('product_unit_cost_details');
        if (cached) return cached;
    }

    const { unitCostDetail, parentPriceFromChildren, PRICE_WINDOW_DAYS } = require('./recipeCost');
    const [products, stockRows] = await Promise.all([
        getProducts(),
        grocyFetch('/objects/stock').catch(() => []),
    ]);

    // Nyeste lagerpost pr. produkt — fallback-trin 3's første led.
    const nyeste = new Map();
    for (const r of (stockRows || [])) {
        const pid = String(r.product_id);
        if (!(parseFloat(r.price) > 0)) continue;
        const nu = nyeste.get(pid);
        if (!nu || String(r.purchased_date || '') > String(nu.purchased_date || '')) nyeste.set(pid, r);
    }

    // Hvilke produkter skal prissættes? Ved en delmængde tages børnene med:
    // en forælder uden egen pris arver gennemsnittet af dem, og uden børnene
    // i kortet ville `kål` stå til "—" i panelet og indgå i totalen med 9,63.
    let maal = products;
    if (subset) {
        const oensket = new Set(subset);
        for (const p of products) {
            if (p.parent_product_id && oensket.has(String(p.parent_product_id))) oensket.add(String(p.id));
        }
        maal = products.filter(p => oensket.has(String(p.id)));
    }

    // Vinduets startdato. `offsetISO` er forankret i Europe/Copenhagen —
    // `new Date().toISOString()` ville give gårsdagens dato mellem midnat og
    // kl. 02 dansk sommertid, og vinduet ville rykke sig en dag om natten.
    const since = offsetISO(-PRICE_WINDOW_DAYS);

    const detaljer = new Map();
    let i = 0;
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
        while (i < maal.length) {
            const p = maal[i++];
            const pid = String(p.id);

            let koeb = null;
            try {
                koeb = await grocyFetch(
                    `/objects/stock_log?query%5B%5D=product_id%3D${p.id}`
                    + `&query%5B%5D=transaction_type%3Dpurchase`
                    + `&query%5B%5D=undone%3D0`
                    + `&order=row_created_timestamp%3Adesc&limit=200`);
            } catch (e) {
                koeb = null;   // loggen kunne ikke læses → fald igennem til trin 3
            }
            if (!Array.isArray(koeb)) koeb = null;

            // Grocys egne tal hentes KUN når loggen intet har at sige.
            let grocyRow = null;
            if (!koeb || !koeb.length) {
                grocyRow = await grocyFetch('/stock/products/' + p.id).catch(() => null);
            }

            const det = unitCostDetail(grocyRow, koeb, {
                since,
                stockRowPrice: nyeste.get(pid) ? nyeste.get(pid).price : null,
            });
            if (det) detaljer.set(pid, det);
            // Ellers: uden pris — resolveren rapporterer den som manglende.
        }
    }));

    // Forældre arver gennemsnittet af de børn der HAR en pris.
    for (const p of maal) {
        if (detaljer.has(String(p.id))) continue;
        const snit = parentPriceFromChildren(products, p.id, cid => detaljer.get(cid)?.cost ?? null);
        if (snit != null) {
            detaljer.set(String(p.id), {
                cost: snit, source: 'parent_avg',
                last_price: null, avg_price: null, deviation_pct: null, warn: false,
                purchases_in_window: 0,
            });
        }
    }

    if (!subset) setCached('product_unit_cost_details', detaljer);
    return detaljer;
}

async function getProductUnitCosts(concurrency = 6, opts = {}) {
    const detaljer = await getProductUnitCostDetails(concurrency, opts);
    const priser = new Map();
    for (const [pid, d] of detaljer) if (d && d.cost > 0) priser.set(pid, d.cost);
    return priser;
}

/**
 * Opskrifter transformeret til picker-format.
 * Filtrerer til sellable=1 og mapper userfields til struktureret objekt.
 */
/**
 * Kostpriser fra `recipe_cost_cache` — fyldt natligt af
 * `scripts/refresh-recipe-costs.js` med `services/recipeCost.js`.
 *
 * Returnerer en tom Map hvis tabellen ikke findes endnu (migration 153 ikke
 * kørt) eller er tom (før første natlige kørsel). Så falder `getRecipes()`
 * tilbage på Grocys tal — ikke fordi det er godt, men fordi det er det vi
 * havde før, og en tom kostpris ville være værre.
 */
function readRecipeCostCache() {
    const m = new Map();
    try {
        const rows = getDb().prepare(
            `SELECT grocy_recipe_id, cost_price_excl_moms, cost_source, missing_prices_json,
                    price_warnings_json
             FROM recipe_cost_cache`
        ).all();
        for (const r of rows) {
            m.set(Number(r.grocy_recipe_id), {
                cost: Number(r.cost_price_excl_moms) || 0,
                source: r.cost_source || 'bon',
                missing: r.missing_prices_json ? JSON.parse(r.missing_prices_json) : null,
                warnings: r.price_warnings_json ? JSON.parse(r.price_warnings_json) : null,
            });
        }
    } catch (e) { /* tabellen findes ikke endnu — fald tilbage */ }
    return m;
}

async function getRecipes() {
    const [raw, fulfillment] = await Promise.all([getRecipesRaw(), getRecipeFulfillment()]);
    // Grocys eget tal beholdes KUN som nødspor. Det er skaleret efter
    // `desired_servings`, det er en forældet cache, og det prissætter bundter
    // og forældre-produkter forkert (#517). Cachen er master.
    const costMap = {};
    for (const f of fulfillment) {
        costMap[f.recipe_id] = f.costs || 0;
    }
    const bonCost = readRecipeCostCache();
    return raw
        .filter(r => {
            const uf = r.userfields || {};
            return String(uf.sellable) === '1';
        })
        .map(r => {
            const uf = r.userfields || {};
            return {
                id: r.id,
                name: r.name,
                category: uf.grupper || null,
                unit: uf.recipeunit || 'stk',
                unit_number: parseFloat(uf.recipeunitnumber) || 1,
                prices: {
                    store:      parseFloat(uf.SalespriceStore) || 0,
                    catering:   parseFloat(uf.SalespriceCatering) || 0,
                    festival:   parseFloat(uf.SalespriceFestival) || 0,
                    produktion: parseFloat(uf.SalespriceProduktion) || 0,
                    waiste:     parseFloat(uf.SalespriceWaiste) || 0,
                },
                cost_price: bonCost.has(r.id)
                    ? bonCost.get(r.id).cost
                    : (costMap[r.id] ?? (parseFloat(uf.costprice) || 0)),
                // Hvor tallet kom fra. 'grocy' betyder at cachen endnu ikke er
                // fyldt — kør scripts/refresh-recipe-costs.js.
                cost_price_source: bonCost.has(r.id) ? bonCost.get(r.id).source : 'grocy',
                // Råvarer uden kendt pris. En opskrift med huller ser ellers
                // præcis ud som en der bare er billig.
                cost_price_missing: bonCost.has(r.id) ? bonCost.get(r.id).missing : null,
                co2e: parseFloat(uf.Co2e) || 0,
            };
        })
        .sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
}

/** Lagerstatus for alle opskrifter (om ingredienserne er på lager) */
function getRecipeFulfillment() {
    return cachedFetch('recipes_fulfillment', '/recipes/fulfillment');
}

/** Ingredienser for én opskrift */
function getRecipeIngredients(recipeId) {
    return cachedFetch(
        `recipe_ing_${recipeId}`,
        `/objects/recipes_pos?query%5B%5D=recipe_id%3D${recipeId}`
    );
}

/** Alle produkter */
function getProducts() {
    return cachedFetch('products', '/objects/products');
}

/** Alt på lager med mængder og udløbsdatoer */
function getStock() {
    return cachedFetch('stock', '/stock');
}

/**
 * Samme data som `getStock()`, men hentet NU — cachen omgås og primes med svaret.
 *
 * Findes fordi et **cachet read ikke må drive en write-beslutning** (#589).
 * `getStock()` har 10 minutters TTL, hvilket er fint til visning: et lagertal
 * der er et par minutter gammelt gør ingen skade på en skærm. Men afgør man
 * HVOR MEGET der skal forbruges ud fra det, regner man på noget man ikke
 * længere ved er sandt — og Grocy svarer 400 "Amount to be consumed cannot be
 * > current stock amount". Målt i drift 03.09: tre bons trak inden for tre
 * sekunder, og de to sidste fejlede på varer der lå tæt på nul.
 *
 * Svaret lægges i cachen bagefter (ikke bare uden om den), så de læsere der
 * kommer lige efter — pakkeliste, råvarer-visning — ser det nye tal i stedet
 * for det gamle der ellers ville blive ved med at ligge til TTL'en løb ud.
 *
 * Lukker IKKE kapløbet i sig selv; den snævrer vinduet fra ti minutter til
 * millisekunder. Det er genforsøget i `consumeRecipes`/`produceBatch` der
 * håndterer resten.
 */
async function getStockFresh() {
    const data = await grocyFetch('/stock');
    setCached('stock', data);
    return data;
}

/**
 * Detaljer for ét produkt: last_price/avg_price (bevaret i Grocys prishistorik
 * UANSET lager) + stock_amount. Bulk-/stock indeholder KUN varer på lager, så
 * priser på udsolgte varer (fx Æbler) mangler der — derfor slås de op her ved
 * kostpris-beregning i Opskrifter & priser.
 */
function getProductDetails(productId) {
    return cachedFetch('product_details_' + productId, '/stock/products/' + productId);
}

/** Udløbende, overskredet og manglende varer (ikke cached — volatile data) */
async function getStockVolatile(dueSoonDays) {
    var days = dueSoonDays || 5;
    var { url, key } = await getGrocyConfig();
    var res = await fetch(url + '/stock/volatile?due_soon_days=' + days, {
        headers: { 'GROCY-API-KEY': key, 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error('Grocy stock/volatile: ' + res.status);
    return res.json();
}

/** Alle enhedstyper (stk, kg, liter …) */
function getQuantityUnits() {
    return cachedFetch('quantity_units', '/objects/quantity_units');
}

/** Enhedskonverteringer (produkt-specifikke + globale) */
function getQuantityUnitConversions() {
    return cachedFetch('qu_conversions', '/objects/quantity_unit_conversions');
}

/** Alle opskriftsingredienser (på tværs af alle opskrifter) */
function getAllRecipesPos() {
    return cachedFetch('all_recipes_pos', '/objects/recipes_pos');
}

/** Underopskrift-relationer (recipes_nestings) */
function getRecipeNestings() {
    return cachedFetch('recipes_nestings', '/objects/recipes_nestings');
}

/** Rå opskrift-data inkl. base_servings (til sub-recipe beregning) */
function getRecipesRawMap() {
    return getRecipesRaw().then(arr => {
        const m = new Map();
        arr.forEach(r => m.set(r.id, r));
        return m;
    });
}

/**
 * Map: recipe_id (number) → economic_product_number (string|null) fra Grocy-userfield.
 * Læser RÅ recipes (IKKE getRecipes(), som filtrerer sellable=1) — en bon kan faktureres
 * efter sæson, hvor recipen er sellable=0. Bruges af e-conomic-fakturaadapteren.
 * Tomme/manglende numre udelades, så opslag returnerer undefined → linjen blokeres (by design).
 */
function getEconomicProductMap() {
    return getRecipesRaw().then(arr => {
        const m = new Map();
        for (const r of arr) {
            const num = r.userfields?.economic_product_number;
            if (num != null && String(num).trim() !== '') {
                m.set(r.id, String(num).trim());
            }
        }
        return m;
    });
}

/**
 * Map: recipe_id → [{ recipe_id, product_number, servings, name }] for "bundter" —
 * opskrifter der IKKE selv har et e-conomic-varenr, men hvis indhold alle har et.
 * I dag rammer det slider-bokserne (77 + 78): ét styk i bon_lines, tre varer på
 * fakturaen. Sammensætningen læses af recipes_nestings, så en ændret boks slår
 * igennem uden manuel kobling — samme kilde som recipe_unit_counts (migration 113).
 *
 * Tre betingelser, alle nødvendige:
 *   1. Opskriften har intet eget varenr — eget nummer vinder ALTID over udfoldning.
 *   2. Den har mindst én nesting.
 *   3. ALLE børn har et varenr. Ét barn uden ⇒ intet bundt, og linjen blokerer som før
 *      (hellere en synlig blokering end en faktura hvor en tredjedel mangler).
 *
 * Almindelige retter rammes ikke: de har eget nummer (1), og deres underopskrifter
 * er produktionsopskrifter uden varenr (3).
 */
function getEconomicBundleMap(recipesArg, nestingsArg) {
    const source = (recipesArg && nestingsArg)      // testsøm — produktionen kalder uden argumenter
        ? Promise.resolve([recipesArg, nestingsArg])
        : Promise.all([getRecipesRaw(), getRecipeNestings()]);
    return source.then(([recipes, nestings]) => {
        const byId = new Map(recipes.map(r => [Number(r.id), r]));
        const ownNumber = (r) => {
            const n = r?.userfields?.economic_product_number;
            return n != null && String(n).trim() !== '' ? String(n).trim() : null;
        };

        const childrenOf = new Map();
        for (const n of nestings) {
            const pid = Number(n.recipe_id);
            if (!childrenOf.has(pid)) childrenOf.set(pid, []);
            childrenOf.get(pid).push(n);
        }

        const out = new Map();
        for (const [pid, list] of childrenOf) {
            const parent = byId.get(pid);
            if (!parent || ownNumber(parent)) continue;

            const parts = [];
            let complete = true;
            for (const n of list) {
                const childId = Number(n.includes_recipe_id);
                const child = byId.get(childId);
                const num = ownNumber(child);
                if (!num) { complete = false; break; }
                const servings = Number(n.servings) > 0 ? Number(n.servings) : 1;
                parts.push({ recipe_id: childId, product_number: num, servings, name: child.name });
            }
            if (complete && parts.length) out.set(pid, parts);
        }
        return out;
    });
}

/**
 * Tilføj varer til Grocy indkøbsliste.
 * @param {Array<{product_id: number, amount: number, note?: string}>} items
 */
async function addToShoppingList(items) {
    const results = [];
    for (const item of items) {
        const r = await grocyPost('/objects/shopping_list', {
            product_id: item.product_id,
            amount:     item.amount,
            note:       item.note || '',
        });
        results.push(r);
    }
    return results;
}

/* ══════════════════════════════════════════════════════════════
   INDKØBSLISTE — udvidede endpoints
   ══════════════════════════════════════════════════════════════ */

/** Hent hele indkøbslisten (ikke cached — ændres hyppigt) */
function getShoppingList() {
    return grocyFetch('/objects/shopping_list');
}

/** Slet enkelt indkøbsliste-item */
function deleteShoppingListItem(id) {
    return grocyDelete(`/objects/shopping_list/${id}`);
}

/**
 * Tilføj produkt til indkøbsliste via Grocy's smart endpoint.
 * Hvis produktet allerede er på listen, øges amount på eksisterende entry
 * (dedup). Note skrives på entry'en — overskriver eksisterende note hvis sat.
 *
 * @param {number} productId
 * @param {number} amount
 * @param {number} [listId=1]
 * @param {string} [note]   Optional. Skrives på entry'en.
 */
async function addShoppingListProduct(productId, amount, listId, note) {
    const body = {
        product_id:     productId,
        product_amount: amount,
        list_id:        listId || 1,
    };
    if (note) body.note = note;
    return grocyPost('/stock/shoppinglist/add-product', body);
}

/** Fjern produkt fra indkøbsliste */
async function removeShoppingListProduct(productId, amount, listId) {
    return grocyPost('/stock/shoppinglist/remove-product', {
        product_id: productId,
        product_amount: amount,
        list_id: listId || 1,
    });
}

/** Tilføj manglende produkter til indkøbsliste */
async function addMissingProducts(listId) {
    return grocyPost('/stock/shoppinglist/add-missing-products', {
        list_id: listId || 1,
    });
}

/** Tilføj udløbne produkter til indkøbsliste */
async function addExpiredProducts(listId) {
    return grocyPost('/stock/shoppinglist/add-expired-products', {
        list_id: listId || 1,
    });
}

/** Tilføj forfaldne produkter til indkøbsliste */
async function addOverdueProducts(listId) {
    return grocyPost('/stock/shoppinglist/add-overdue-products', {
        list_id: listId || 1,
    });
}

/** Ryd hele indkøbslisten */
async function clearShoppingList(listId) {
    return grocyPost('/stock/shoppinglist/clear', {
        list_id: listId || 1,
    });
}

/** Alle indkøbslokationer */
function getShoppingLocations() {
    return cachedFetch('shopping_locations', '/objects/shopping_locations');
}

/** Alle produkt-barcodes (cached, bruges til leverandør-matching i bestilling) */
function getProductBarcodes() {
    return cachedFetch('product_barcodes', '/objects/product_barcodes');
}

/** Opret ny produkt-barcode (kobl vare til leverandør-varenr.).
 *  Patch C #015: Grocy returnerer 500 ved duplikat (product_id, barcode).
 *  Vi mapper det til en kaste-fejl med status=409 og code='BARCODE_DUPLICATE'
 *  så route-handleren kan emit'e en pænere fejl til klienten.
 */
async function createProductBarcode(body) {
    try {
        const result = await grocyPost('/objects/product_barcodes', body);
        _cache.delete('product_barcodes');
        return result;
    } catch (err) {
        // Grocy returnerer 400 eller 500 ved duplikat barcode (afhænger af version).
        // Vi matcher på constraint/unique/duplicate i message-teksten — ikke på status —
        // for at være robust på tværs af Grocy-versioner.
        const msg = String(err?.message || '').toLowerCase();
        const isDuplicate = msg.includes('constraint')
            || msg.includes('unique')
            || msg.includes('duplicate');

        if (isDuplicate) {
            const conflictErr = new Error(
                `Barcode '${body?.barcode}' eksisterer allerede for product_id=${body?.product_id}`
            );
            conflictErr.status = 409;
            conflictErr.code = 'BARCODE_DUPLICATE';
            throw conflictErr;
        }
        throw err;
    }
}

/** Opdater produkt-barcode (last_price, note, qu_id, amount etc.) */
async function updateProductBarcode(id, body) {
    await grocyPut(`/objects/product_barcodes/${id}`, body);
    _cache.delete('product_barcodes');
}

/** Opdater userfields på produkt-barcode (is_preferred, supplier_unit_code etc.) */
async function updateProductBarcodeUserfields(id, fields) {
    await grocyPut(`/userfields/product_barcodes/${id}`, fields);
    _cache.delete('product_barcodes');
}

/** Opdater produkt (shopping_location_id, min_stock_amount etc.) */
async function updateProduct(id, body) {
    await grocyPut(`/objects/products/${id}`, body);
    _cache.delete('products');
}

/** Slet produkt-barcode (bruges ved flytning af kobling) */
/**
 * Slet et produkt.
 *
 * Grocy nægter selv hvis produktet har lagerbevægelser, men kalderen bør tjekke
 * FØR: en fejlbesked fra Grocy er ikke et godt sted at opdage at man var ved at
 * slette noget med historik.
 */
async function deleteProduct(id) {
    const result = await grocyDelete(`/objects/products/${id}`);
    _cache.delete('products');
    return result;
}

async function deleteProductBarcode(id) {
    await grocyDelete(`/objects/product_barcodes/${id}`);
    _cache.delete('product_barcodes');
}

/**
 * Opdater userfields på en shopping_list-linje (fx ordered_* userfields).
 * Grocy kræver at userfields opdateres via /userfields/ endpoint — ikke via /objects/.
 */
async function updateShoppingListItem(id, fields) {
    // Hvis der er userfields, send dem via userfields-endpoint
    if (fields.userfields) {
        await grocyPut(`/userfields/shopping_list/${id}`, fields.userfields);
    }
    // Hvis der er andre felter (amount etc.), send via objects-endpoint
    const otherFields = Object.assign({}, fields);
    delete otherFields.userfields;
    if (Object.keys(otherFields).length > 0) {
        await grocyPut(`/objects/shopping_list/${id}`, otherFields);
    }
}

/**
 * Anvend pakke-justeringer på en resolved consume-liste (REN, ingen Grocy-kald).
 * Delt af consumeRecipes (det rigtige træk) og planConsume (read-only preview),
 * så preview garanteret matcher virkeligheden.
 *
 * - overrides ERSTATTER en vares mængde (buffer-in-place på direkte varer).
 * - extras ADDERER oveni (eller tilføjer en ny consume-post hvis varen ikke er
 *   i opskrifterne).
 * Hver vare annoteres med recipe_amount/override_amount/extra_amount til preview.
 *
 * @param {Array} items   resolveConsumeItems-output (muteres + returneres)
 * @param {Map|Object|null} overrides  product_id → packed_amount (stock-units)
 * @param {Array|null} extras  [{ product_id, amount, product_name? }]
 * @param {Map} productMap  product_id → Grocy-produkt (til nye extra-varers metadata)
 */
function applyPackingAdjustments(items, overrides, extras, productMap) {
    for (const it of items) it.recipe_amount = it.amount_stock;

    if (overrides) {
        const get = overrides instanceof Map
            ? (pid) => (overrides.has(pid) ? overrides.get(pid) : undefined)
            : (pid) => overrides[pid];
        for (const it of items) {
            const ov = get(it.product_id);
            if (ov !== undefined && ov !== null && !Number.isNaN(Number(ov))) {
                it.amount_stock = Number(ov);
                it.override_amount = Number(ov);
            }
        }
    }

    if (extras && extras.length) {
        const itemByPid = new Map(items.map(it => [it.product_id, it]));
        for (const ex of extras) {
            const pid = parseInt(ex.product_id);
            const amt = Number(ex.amount);
            if (!pid || Number.isNaN(amt) || amt <= 0) continue;
            const existing = itemByPid.get(pid);
            if (existing) {
                existing.amount_stock += amt;
                existing.extra_amount = (existing.extra_amount || 0) + amt;
            } else {
                const p = (productMap && productMap.get(pid)) || {};
                const ni = {
                    product_id:        pid,
                    product_name:      p.name || ex.product_name || `Produkt #${pid}`,
                    amount_stock:      amt,
                    qu_id_stock:       p.qu_id_stock || null,
                    qu_id_purchase:    p.qu_id_purchase || null,
                    parent_product_id: p.parent_product_id ? parseInt(p.parent_product_id) : null,
                    purchase_factor:   1,
                    recipe_amount:     0,
                    extra_amount:      amt,
                };
                items.push(ni);
                itemByPid.set(pid, ni);
            }
        }
    }
    return items;
}

const SHORTFALL_TOL = 0.001;

/**
 * Hvad skal der ske med en mangel? REN funktion, så reglen kan efterprøves
 * uden at kalde Grocy — plumbingen nedenfor er triviel, beslutningen er det ikke.
 *
 * Et mellemprodukt kan ikke købes. "Remoulade" står ikke i noget katalog; den
 * laves af mayo og relish. Lagde vi den på indkøbslisten, ville køkkenet få en
 * besked om at bestille noget ingen leverandør sælger — og den ægte mangel
 * (råvarerne) ville stå og blinke et andet sted. Spec §4.4 siger det direkte:
 * det er RÅVARERNE der skal på listen.
 *
 * Auto-batchen (#267) lægger dem allerede på for de batches den planlagde. Vi
 * tilføjer dem derfor ikke en gang til her — Grocys shopping-list-endpoint
 * lægger sammen frem for at erstatte, så det ville blive dobbelt. Manglen
 * rapporteres i stedet tilbage til kalderen, så den er synlig frem for tavs.
 *
 * @param {{product_id:number, purchase_factor?:number}} item
 * @param {number} shortfallStock  mangel i lager-enhed
 * @param {Set<number>} producedProductIds  produkter en opskrift kan lave
 * @returns {null | {action:'buy', amountPurchase:number} | {action:'produce', reason:string}}
 */
function planShortfall(item, shortfallStock, producedProductIds) {
    if (!(shortfallStock > SHORTFALL_TOL)) return null;
    if (producedProductIds && producedProductIds.has(Number(item.product_id))) {
        return { action: 'produce', reason: 'produceret_mellemprodukt' };
    }
    const factor = item.purchase_factor || 1;
    return { action: 'buy', amountPurchase: Math.ceil(shortfallStock * factor) };
}

/**
 * Hvad betyder en mangel på en vare der LAVES i stedet for at købes?
 *
 * REN funktion. Efter konverteringen (#270) står et mellemprodukt normalt på 0
 * mellem to leveringer — det er meningen. Viste forhåndsvisningen det som en
 * almindelig mangel, ville køkkenet se "Frisk Grønt mangler 13 kg" på 28 retter
 * og ikke kunne skelne det fra en ægte mangel. Alarmen ville holde op med at
 * betyde noget.
 *
 * De to kategorier har hver sit svar (§2):
 *   Hurtig  — Bon laver den ved LEVERET. Rækker råvarerne, er der intet at gøre.
 *   RR      — personalet laver den efter plan. Bon rører den ALDRIG, så en
 *             mangel her er en besked til et menneske, ikke en indkøbslinje.
 *
 * @param producers  buildProducerIndex-opslag for varen (kan være undefined)
 * @param batch      planAutoBatches-resultatet for varen (kan være undefined)
 * @param erHurtig   prædikat fra services/autoBatch — grænsen mellem de to
 *                   kategorier defineres ÉT sted, ikke to
 */
function classifyProducedShortfall(producers, batch, erHurtig) {
    // `is_real_shortfall` er VURDERINGEN: skal det her råbes op om?
    // Den hører hjemme ét sted. Regnede frontenden den selv, ville de to kunne
    // skride fra hinanden — og så ville skærmen sige noget andet end serveren.
    if (!producers || !producers.length) return { produced_by: null, is_real_shortfall: true };
    const hurtig = producers.some(r => erHurtig(r));
    // RR-produktion laver personalet efter plan. Bon rører den aldrig, så en
    // mangel her er en ægte besked — bare til et menneske, ikke til indkøb.
    if (!hurtig) return { produced_by: 'personale', is_real_shortfall: true };
    // Hurtig uden en plan: vi ved det ikke, så vi dæmper ikke alarmen.
    if (!batch) return { produced_by: 'bon', is_real_shortfall: true };
    const dækket = batch.batches_made >= batch.batches_needed;
    return {
        produced_by: 'bon',
        batches_needed: batch.batches_needed,
        batches_made:   batch.batches_made,
        produce_amount: batch.produce_amount,
        // Kun det der reelt spærrer. Rækker råvarerne, er listen tom.
        produce_missing: dækket ? [] : (batch.missing || []).map(m => ({
            product_name: m.product_name, needed: m.needed, stock: m.stock,
        })),
        // Bon laver den om et øjeblik. Det er ikke en mangel.
        is_real_shortfall: !dækket,
    };
}


/**
 * Byg en effektiv-lager-funktion: en parent-vare (fx "Kål") har selv stock=0,
 * men dens børn (Spidskål, Hvidkål) har lager — summér familien.
 */
function makeEffectiveStock(stock, products) {
    const stockByPid = new Map();
    for (const s of stock) stockByPid.set(parseInt(s.product_id), parseFloat(s.amount) || 0);
    const childrenByParent = new Map();
    for (const p of products) {
        if (p.parent_product_id) {
            const par = parseInt(p.parent_product_id);
            if (!childrenByParent.has(par)) childrenByParent.set(par, []);
            childrenByParent.get(par).push(parseInt(p.id));
        }
    }
    return function effectiveStock(pid) {
        const ownStock = stockByPid.get(pid) || 0;
        const kids = childrenByParent.get(pid) || [];
        if (!kids.length) return ownStock;
        let sum = ownStock;
        for (const kid of kids) sum += stockByPid.get(kid) || 0;
        return sum;
    };
}

/**
 * Hvor mange gange et afvist consume prøves igen med et friskt lagertal.
 *
 * Ikke nul: at hente lageret friskt lige inden trækket snævrer kapløbet, men
 * lukker det ikke — to leveringer kan stadig ramme millisekunderne mellem vores
 * læsning og vores skrivning. Ikke uendeligt: hver runde er et rundtur til
 * Grocy, og en fejl der ikke handler om lageret skal frem, ikke skjules bag
 * genforsøg. To er valgt fordi drift 03.09 havde TRE bons inden for tre
 * sekunder (#589) — med ét genforsøg kan den sidste i køen tabe igen.
 */
const CONSUME_RETRY_ATTEMPTS = 2;

/**
 * Forbrug `amount` af et produkt. Afvises det, læs lageret FRISKT og træk det
 * der faktisk er.
 *
 * Kernen i #589. Afvisningen genkendes IKKE på Grocys fejltekst — den er
 * engelsk, tredjeparts og kan ændre sig. I stedet spørger vi lageret igen:
 * siger det mindre end vi bad om, VAR vores tal forældet, og det friske tal er
 * svaret. Siger det ikke mindre, handlede fejlen om noget andet (nede, 500,
 * ukendt produkt) og skal stå som en fejl.
 *
 * Et træk der klampes ned til nul er ikke en fejl: det er den sande tilstand
 * "der er ikke noget", og kalderen skal håndtere den som en mangel — altså med
 * en linje på indkøbslisten — ikke som et mislykket kald.
 *
 * @returns {{ consumed: number, error: string|null, clamped: boolean, response: any }}
 *   `consumed` hvad der FAKTISK blev trukket (kalderen skal regne manglen ud
 *   fra dette tal, ikke fra det den bad om — ellers bliver indkøbslinjen for lille).
 *   `response` Grocys svar på det kald der lykkedes — `produceBatch` henter
 *   transaction-id'et ud af det til revisionssporet.
 */
async function consumeWithFreshRetry(productId, amount, opts = {}) {
    const {
        allowSubstitution = false,
        attempts           = CONSUME_RETRY_ATTEMPTS,
    } = opts;
    // Eksplicit frem for destructuring-standarder: en kalder der sender
    // `post: undefined` videre (fordi DENS deps var tomme) skal have den
    // rigtige — ikke undefined.
    const post         = opts.post         || grocyPost;
    const readStock    = opts.readStock    || getStockFresh;
    const readProducts = opts.readProducts || getProducts;

    let want = Number(amount) || 0;
    let clamped = false;
    let lastError = null;

    for (let tries = 0; ; tries++) {
        if (!(want > SHORTFALL_TOL)) return { consumed: 0, error: null, clamped, response: null };

        try {
            const response = await post(`/stock/products/${productId}/consume`, {
                amount:           want,
                transaction_type: 'consume',
                spoiled:          false,
                // Parent-produkter (fx "Kål") har stock=0 men kan substitueres af
                // børn med stock (Spidskål, Hvidkål). Uden dette flag fejler consume
                // med 400 "No transaction was found by the given transaction id".
                ...(allowSubstitution ? { allow_subproduct_substitution: true } : {}),
            });
            return { consumed: want, error: null, clamped, response };
        } catch (err) {
            lastError = err.message;
            if (tries >= attempts) return { consumed: 0, error: lastError, clamped, response: null };

            let available = null;
            try {
                const [stock, products] = await Promise.all([readStock(), readProducts()]);
                available = makeEffectiveStock(stock, products)(productId);
            } catch (readErr) {
                // Kan vi ikke læse lageret, kan vi ikke vide bedre end sidste gang.
                return { consumed: 0, error: lastError, clamped, response: null };
            }

            // Ikke lavere end det vi bad om ⇒ fejlen handlede om noget andet.
            if (!(available < want - SHORTFALL_TOL)) {
                return { consumed: 0, error: lastError, clamped, response: null };
            }
            want = Math.max(0, available);
            clamped = true;
        }
    }
}

/**
 * Forbruger ingredienser fra Grocy-lager for en liste bon-linjer.
 *
 * Ny tilgang (erstatter gammel recipe-level consume):
 * 1. Resolver ALLE ingredienser inkl. underopskrifter via ingredientResolver
 * 2. Aggregerer per product_id (inkl. emballage)
 * 3. Kalder POST /stock/products/{id}/consume per produkt
 * 4. Returnerer per-produkt results (partial success ved fejl)
 *
 * @param {Array<{grocy_recipe_id: number, quantity: number}>} lines  Bon-linjer
 * @param {Object} [deps]  Test-søm (samme mønster som `produceBatch`/`runAutoBatches`):
 *   `readStock`, `readProducts`, `post`, `addToShoppingList`. I drift er alle
 *   fire de rigtige. Sømmet findes fordi kapløbet mellem to samtidige træk ikke
 *   kan fremprovokeres mod en rigtig Grocy — og det var netop fordi den tilstand
 *   aldrig blev testet at #589 overlevede.
 * @returns {Array<{product_id: number, product_name: string, amount: number, success: boolean, error?: string}>}
 */
async function consumeRecipes(lines, overrides = null, extras = null, recipeFactors = null, deps = {}) {
    const readStock    = deps.readStock    || getStockFresh;
    const readProducts = deps.readProducts || getProducts;
    const addToList    = deps.addToShoppingList || addShoppingListProduct;
    const validLines = lines.filter(l => l.grocy_recipe_id);
    if (!validLines.length) return [];

    // Lazy require for at undgå cirkulær dependency
    const { resolveConsumeItems } = require('./ingredientResolver');

    let items;
    try {
        items = await resolveConsumeItems(validLines, recipeFactors);
    } catch (err) {
        console.error('[consume] Fejl ved ingredient-opløsning:', err);
        return [{ product_id: 0, product_name: '(resolver fejl)', amount: 0, success: false, error: err.message }];
    }

    if (!items.length) return [];

    // ── Stock + produkter (til partial-consume, parent-substitution, extra-metadata) ──
    //
    // FRISKT lager, ikke det cachede (#589): herunder afgøres HVOR MEGET der
    // skal trækkes, og den beslutning må ikke bygge på et tal der kan være ti
    // minutter gammelt. `getProducts()` er stadig cachet — stamdata ændrer sig
    // ikke mellem to leveringer, og en forældet produktliste kan ikke få Grocy
    // til at afvise et træk.
    let stock = [];
    let products = [];
    try {
        [stock, products] = await Promise.all([readStock(), readProducts()]);
    } catch (err) {
        console.warn('[consume] Kunne ikke hente stock/products til partial-check:', err.message);
        // Fortsæt uden partial-logik — fallback til simple consume
    }
    const productMap = new Map(products.map(p => [parseInt(p.id), p]));

    // Pakke-justeringer (overrides erstatter, extras adderer) — DELT med planConsume,
    // så den read-only preview garanteret matcher det rigtige træk.
    applyPackingAdjustments(items, overrides, extras, productMap);
    if (!items.length) return [];

    const effectiveStock = makeEffectiveStock(stock, products);

    // Hvilke produkter LAVES af en opskrift? De kan ikke købes.
    // Gælder begge kategorier: Bon laver aldrig et `RR Produktion`-produkt
    // (gris, sylt), men det gør personalet — og det er stadig ikke noget man
    // bestiller hos en leverandør.
    let producedProductIds = new Set();
    try {
        const { buildProducerIndex } = require('./ingredientResolver');
        producedProductIds = new Set([...buildProducerIndex(await getRecipesRawMap()).keys()]);
    } catch (err) {
        // Kan vi ikke afgøre det, opfører vi os som før: hellere en linje for
        // meget på indkøbslisten end et tabt signal om en mangel.
        console.warn('[consume] Kunne ikke afgøre hvilke varer der produceres:', err.message);
    }

    // ── Consume hvert produkt med partial-fallback + shopping-list-add ──
    //
    // Replikerer Bon v1's adfærd: når der ikke er nok lager til at dække behovet,
    // trækker vi det der ER på lageret (partial), og lægger en hel purchase-enhed
    // på Grocy's shopping_list så indkøb sker næste gang. Uden dette ender bonnen
    // som "trukket" (inventory_deducted=1) selvom intet faktisk blev konsumeret.
    const results = [];
    try {
        for (const item of items) {
            const needed   = item.amount_stock;
            const available = effectiveStock(item.product_id);
            const planned = Math.min(needed, available);

            // Trin 1: consume det vi kan (kan være 0 hvis lager er tomt).
            // Afvises trækket, læser helperen lageret på ny og trækker det der ER —
            // så en bon ikke ender som `partial` alene fordi to leveringer nåede at
            // læse samme snapshot (#589).
            let consumed = 0;
            if (planned > SHORTFALL_TOL) {
                const res = await consumeWithFreshRetry(item.product_id, planned, {
                    allowSubstitution: true,
                    post: deps.post, readStock, readProducts,
                });
                if (res.error) {
                    results.push({
                        product_id:   item.product_id,
                        product_name: item.product_name,
                        amount:       planned,
                        success:      false,
                        error:        res.error,
                    });
                    continue;
                }
                consumed = res.consumed;
            }

            // Manglen regnes ud fra hvad der FAKTISK blev trukket — ikke fra det vi
            // bad om. Klampede genforsøget mængden ned, er der så meget desto mere
            // at købe, og en mangel regnet på det oprindelige tal ville give en
            // indkøbslinje der er for lille.
            const shortfallStock = Math.max(0, needed - consumed);

            // Trin 2: hvis der mangler, læg purchase-enhed(er) på shopping list.
            // Bruger Grocys smart endpoint der DEDUPPER — samme product_id øger qty
            // på eksisterende entry i stedet for at oprette duplikat.
            //
            // Men KUN hvis varen overhovedet kan købes: se planShortfall.
            let shortfallPurchase = 0;
            let notPurchasable = false;
            const plan = planShortfall(item, shortfallStock, producedProductIds);
            if (plan && plan.action === 'buy') {
                shortfallPurchase = plan.amountPurchase;
                const noteText = `Auto-tilføjet ved LEVERET (manglede ${shortfallStock.toFixed(3)} fra consume)`;
                try {
                    await addToList(item.product_id, shortfallPurchase, 1, noteText);
                } catch (err) {
                    console.warn(`[consume] Kunne ikke tilføje pid=${item.product_id} til shopping list:`, err.message);
                    // Ikke en hård fejl — consume lykkedes (delvist), shopping-list-add er ekstra
                }
            } else if (plan && plan.action === 'produce') {
                notPurchasable = true;
                console.warn(`[consume] ${item.product_name} mangler ${shortfallStock.toFixed(3)} — `
                           + 'mellemprodukt, så det kommer IKKE på indkøbslisten. '
                           + 'Auto-batchen laver det, eller råvarerne mangler.');
            }

            results.push({
                product_id:         item.product_id,
                product_name:       item.product_name,
                amount:             consumed,
                shortfall_stock:    shortfallStock,
                shortfall_purchase: shortfallPurchase,
                // Manglen findes, men kan ikke købes. Siges højt frem for at
                // forsvinde — ellers er "ingen indkøbslinje" ikke til at skelne
                // fra "ingen mangel".
                shortfall_not_purchasable: notPurchasable,
                partial:            shortfallStock > SHORTFALL_TOL && consumed > SHORTFALL_TOL,
                success:            true,
            });
        }
    } finally {
        // Ryd stock-cache efter forbrug — også hvis løkken afbrydes undervejs.
        // Har vi trukket ÉN vare, er det cachede tal forkert for den vare, og
        // den næste læser må ikke få det serveret som sandhed.
        _cache.delete('stock');
        _cache.delete('shopping_list');
    }
    return results;
}

/**
 * Read-only: beregn PRÆCIS hvad consumeRecipes ville trække fra HQ for en bon
 * (inkl. overrides + extras) UDEN at kalde Grocy's consume. Bruger NØJAGTIG de
 * samme delte helpers (applyPackingAdjustments + makeEffectiveStock) som det
 * rigtige træk, så drift kan verificere lagertrækket før LEVERET uden risiko.
 *
 * @returns {Promise<{ items: Array<{ product_id, product_name, recipe_amount,
 *   override_amount, extra_amount, final_amount, in_stock, shortfall }> }>}
 */
async function planConsume(lines, overrides = null, extras = null, recipeFactors = null) {
    const validLines = (lines || []).filter(l => l.grocy_recipe_id);
    const { resolveConsumeItems } = require('./ingredientResolver');

    let items = [];
    if (validLines.length) items = await resolveConsumeItems(validLines, recipeFactors);
    if (!items.length && !(extras && extras.length)) return { items: [] };

    let stock = [];
    let products = [];
    let units = [];
    try {
        // Samme FRISKE læsning som det rigtige træk (#589). Forhåndsvisningens
        // hele formål er at vise hvad LEVERET ville gøre — læste den et andet
        // (ældre) lagertal end trækket, ville de to kunne vise hver sit, og så
        // er den ikke længere en forhåndsvisning af noget.
        [stock, products, units] = await Promise.all([getStockFresh(), getProducts(), getQuantityUnits()]);
    } catch (err) {
        console.warn('[planConsume] Kunne ikke hente stock/products:', err.message);
    }
    const productMap = new Map(products.map(p => [parseInt(p.id), p]));
    const unitMap = new Map(units.map(u => [u.id, u.name_short || u.name || '']));
    applyPackingAdjustments(items, overrides, extras, productMap);

    const effectiveStock = makeEffectiveStock(stock, products);

    // ── Hvad ville auto-batchen gøre? ────────────────────────────────────
    //
    // Efter konverteringen står et mellemprodukt normalt på 0 mellem to
    // leveringer. Uden det her ville forhåndsvisningen vise "Frisk Grønt
    // mangler 13 kg" på 28 retter og se ud som en katastrofe — mens Bon
    // laver den et øjeblik senere.
    //
    // Svaret hentes fra planAutoBatches, altså PRÆCIS den funktion der
    // træffer beslutningen ved LEVERET. En parallel udregning her ville
    // kunne vise noget andet end det der så faktisk sker.
    let producerIndex = new Map(), planByPid = new Map(), erHurtig = () => false;
    try {
        const { buildProducerIndex, productionTypeOf } = require('./ingredientResolver');
        const { planAutoBatches } = require('./autoBatch');
        const [rawRecipeMap, allPos, nestings, quConversions] = await Promise.all([
            getRecipesRawMap(), getAllRecipesPos(), getRecipeNestings(), getQuantityUnitConversions(),
        ]);
        const posByRecipe = {}, nestingsByRecipe = {};
        for (const x of allPos)   (posByRecipe[x.recipe_id] ||= []).push(x);
        for (const n of nestings) (nestingsByRecipe[n.recipe_id] ||= []).push(n);
        producerIndex = buildProducerIndex(rawRecipeMap);
        erHurtig = (r) => productionTypeOf(r) === 'on_demand';
        const plan = planAutoBatches({
            needs: items.map(it => ({ product_id: it.product_id, amount_stock: it.amount_stock })),
            rawRecipeMap, posByRecipe, nestingsByRecipe, productMap,
            unitMap: new Map(units.map(u => [Number(u.id), u])),
            quConversions, effectiveStock,
        });
        planByPid = new Map(plan.batches.map(b => [b.product_id, b]));
    } catch (err) {
        // Kan vi ikke afgøre det, viser vi manglen råt som før. Hellere en
        // alarm for meget end en forhåndsvisning der lover en produktion.
        console.warn('[planConsume] Kunne ikke afgøre auto-batch:', err.message);
    }

    const result = items.map(it => {
        const inStock = effectiveStock(it.product_id);
        const final = it.amount_stock;
        const p = productMap.get(it.product_id) || {};
        const shortfall = Math.max(0, final - inStock);
        return {
            product_id:      it.product_id,
            product_name:    it.product_name,
            unit:            unitMap.get(it.qu_id_stock ?? p.qu_id_stock) || '',
            recipe_amount:   it.recipe_amount || 0,
            override_amount: it.override_amount ?? null,
            extra_amount:    it.extra_amount || 0,
            final_amount:    final,
            in_stock:        inStock,
            shortfall,
            // Kun relevant når der faktisk mangler noget.
            ...(shortfall > 0.001
                ? classifyProducedShortfall(producerIndex.get(it.product_id), planByPid.get(it.product_id), erHurtig)
                : {}),
        };
    }).sort((a, b) => a.product_name.localeCompare(b.product_name, 'da'));

    return { items: result };
}

/**
 * Consume ét produkt fra Grocy-lager.
 * @param {number} productId  Grocy product ID
 * @param {number} amount     Mængde i stock-units
 */
async function consumeProduct(productId, amount) {
    const resp = await grocyPost(`/stock/products/${productId}/consume`, {
        amount,
        transaction_type: 'consume',
        spoiled: false,
        // Tillader parent-produkter (med stock=0) at substituere fra børn — se consumeRecipes
        allow_subproduct_substitution: true,
    });
    _cache.delete('stock');
    return _extractTransactionId(resp);
}

/** Grocy consume/add svarer med [{ transaction_id, ... }] (eller {} ved 204). */
function _extractTransactionId(resp) {
    const arr = Array.isArray(resp) ? resp : [resp];
    return arr[0]?.transaction_id ?? arr[0]?.stock_row?.transaction_id ?? null;
}

/**
 * Tilføj til lagerbeholdning (ved varemodtagelse).
 * @param {number} productId         Grocy product ID
 * @param {number} amount            Mængde i stock-units
 * @param {string} [bestBeforeDate]  Udløbsdato (YYYY-MM-DD)
 * @param {number} [locationId]      Grocy location ID
 */
async function addToStock(productId, amount, bestBeforeDate, locationId) {
    const body = { amount };
    if (bestBeforeDate) body.best_before_date = bestBeforeDate;
    if (locationId) body.location_id = locationId;
    await grocyPost(`/stock/products/${productId}/add`, body);
    _cache.delete('stock');
}

/**
 * Tilføj til lagerbeholdning med fuld kontrol over body.
 * Bruges af opret-produkt (initial lager + pris pr. stock-enhed).
 * @param {number} productId  Grocy product ID
 * @param {Object} body       { amount, best_before_date?, transaction_type?, price?, location_id?, shopping_location_id? }
 */
async function addToStockFull(productId, body) {
    const payload = {
        transaction_type: 'purchase',
        ...body,
    };
    if (!payload.best_before_date) payload.best_before_date = '2999-12-31';
    const resp = await grocyPost(`/stock/products/${productId}/add`, payload);
    _cache.delete('stock');
    return _extractTransactionId(resp);
}

/**
 * Producér en batch (MVP) — driver hvert lagertræk MANUELT, så Grocys
 * alt-eller-intet recipe-consume aldrig rammer os på afvigelsesdagen.
 * Spec: docs/CLAUDE_PRODUKTION_MVP.md §2 + §10.
 *
 * Consumes køres SEKVENTIELT (ikke Promise.all) så fejlede linjer er kendte.
 * En linje med amount ≤ 0 springes over (= "råvaren manglede" → intet kald →
 * kan ikke blokere). Self-production add lægger færdigvaren på lager med
 * eksplicit ex-moms-pris.
 *
 * `deps.post` kan injiceres i unit-tests (default = grocyPost).
 *
 * @param {object} plan
 * @param {Array<{productId:number, amount:number}>} plan.consume  stock-enhed
 * @param {{productId:number, amount:number, price:number, bestBeforeDate?:string}} plan.produce
 * @param {object} [deps]  { post }
 * @returns {Promise<{state:string, consumeTx:Array, produceTx:string|null, produceError:string|null, failedLines:Array}>}
 */
async function produceBatch({ consume = [], produce }, deps = {}) {
    const post = deps.post || grocyPost;
    const consumeTx = [];
    const failedLines = [];

    for (const line of consume) {
        const amount = Number(line.amount) || 0;
        if (amount <= 0) continue;  // udeladt — intet kald (det LETTE tilfælde)
        // Samme klamp + genforsøg som `consumeRecipes` (#589). Her var der før
        // slet INGEN klamp: mængden gik direkte fra planen til Grocy. Det holdt
        // kun fordi `affordableBatches` vetoede alt lageret ikke dækkede fuldt
        // ud — og netop det veto er væk med #560, så auto-batchen nu trækker
        // dét der ligger tæt på nul. Uden klampen ville den ramme samme 400.
        //
        // Bemærk at helperen returnerer `consumed`: trækkes der mindre end
        // planlagt, er det DEN mængde der er sand, og `produceBatch` skal ikke
        // lade som om resten også blev trukket.
        const res = await consumeWithFreshRetry(line.productId, amount, {
            post, readStock: deps.readStock, readProducts: deps.readProducts,
        });
        if (res.error) {
            // MVP: marker linjen, fortsæt de øvrige (ingen rollback — fejl er synlig pr. linje)
            failedLines.push({ productId: line.productId, amount, error: res.error });
        } else {
            consumeTx.push({
                productId:     line.productId,
                transactionId: _extractTransactionId(res.response),
                amount:        res.consumed,
                clamped:       res.clamped,
            });
        }
    }

    let produceTx = null;
    let produceError = null;
    if (produce) {
        try {
            const resp = await post(`/stock/products/${produce.productId}/add`, {
                amount:            produce.amount,
                transaction_type:  'self-production',
                price:             produce.price,
                best_before_date:  produce.bestBeforeDate || '2999-12-31',
            });
            produceTx = _extractTransactionId(resp);
        } catch (err) {
            produceError = err.message;
        }
    }

    _cache.delete('stock');

    const state = (failedLines.length === 0 && !produceError) ? 'produced' : 'partial';
    return { state, consumeTx, produceTx, produceError, failedLines };
}

/**
 * Opret nyt produkt i Grocy.
 * @param {Object} body  { name, qu_id_purchase, qu_id_stock, location_id, ... }
 * @returns {Promise<{created_object_id:number}>}
 */
async function createProduct(body) {
    const result = await grocyPost('/objects/products', body);
    _cache.delete('products');
    return result;
}

/**
 * Opret quantity-unit-konvertering på et produkt.
 * Bruges når indkøbs-QU ≠ lager-QU (fx 1 kasse = 6000 g).
 * @param {Object} body  { product_id, from_qu_id, to_qu_id, factor }
 * @returns {Promise<{created_object_id:number}>}
 */
async function createQuConversion(body) {
    const result = await grocyPost('/objects/quantity_unit_conversions', body);
    _cache.delete('qu_conversions');
    return result;
}

/** Slet en enheds-omregning. Findes så en konvertering kan fortrydes helt. */
async function deleteQuConversion(id) {
    const result = await grocyDelete(`/objects/quantity_unit_conversions/${id}`);
    _cache.delete('qu_conversions');
    return result;
}

/**
 * Hent userfield-meta (alle entiteters userfields).
 * Frontend filtrerer selv på `entity === 'products'` osv.
 */
function getUserfields() {
    return cachedFetch('userfields', '/objects/userfields');
}

/**
 * Sæt eksakt lagerbeholdning for et produkt (inventory correction).
 * @param {number} productId       Grocy product ID
 * @param {number} amount          Ny mængde i stock-units
 * @param {string} [bestBeforeDate] Udløbsdato (YYYY-MM-DD), valgfri
 */
async function setInventory(productId, amount, bestBeforeDate) {
    const body = {
        new_amount: amount,
    };
    if (bestBeforeDate) body.best_before_date = bestBeforeDate;
    try {
        await grocyPost(`/stock/products/${productId}/inventory`, body);
    } catch (err) {
        // Grocy afviser når new_amount == nuværende beholdning
        // ("The new amount cannot equal the current stock amount"). For en
        // optælling/justering betyder det bare at lageret allerede er korrekt
        // → behandl som no-op, ikke en fejl. (Snapshot kan være forældet pga.
        // auto-forbrug når bons leveres.)
        const msg = (err && err.message) || '';
        if (/cannot equal the current stock amount/i.test(msg)) {
            return { ok: true, unchanged: true };
        }
        throw err;
    }
    _cache.delete('stock');
    return { ok: true };
}

/** Alle lokationer */
function getLocations() {
    return cachedFetch('locations_grocy', '/objects/locations');
}

/** Alle produktgrupper */
function getProductGroups() {
    return cachedFetch('product_groups', '/objects/product_groups');
}

/**
 * Opdater userfields på et produkt (fx LastCheckedAt).
 * @param {number} productId  Grocy product ID
 * @param {Object} fields     Felter at opdatere
 */
async function updateProductUserfields(productId, fields) {
    await grocyPut(`/userfields/products/${productId}`, fields);
    _cache.delete('products');
}

/* ══════════════════════════════════════════════════════════════ */

module.exports = {
    // Read
    getRecipes,
    getRecipesRaw,
    getProductUnitCosts,
    getProductUnitCostDetails,
    readRecipeCostCache,
    getRecipesRawMap,
    getEconomicProductMap,
    getEconomicBundleMap,
    getRecipeFulfillment,
    getRecipeIngredients,
    getRecipeNestings,
    getProducts,
    getStock,
    getStockFresh,
    getProductDetails,
    getStockVolatile,
    getLocations,
    getProductGroups,
    getQuantityUnits,
    getQuantityUnitConversions,
    getAllRecipesPos,
    // Write — recipes
    createRecipe,
    updateRecipe,
    updateRecipeUserfields,
    // Write — recipe positions (ingredients)
    createRecipePos,
    updateRecipePos,
    deleteRecipePos,
    // Write — recipe nestings (sub-recipes)
    createRecipeNesting,
    updateRecipeNesting,
    deleteRecipeNesting,
    // Write — stock + shopping
    consumeRecipes,
    consumeWithFreshRetry,
    planConsume,
    makeEffectiveStock,
    // Delt af det rigtige træk, previewet OG auto-batchen — de tre skal regne
    // på det samme behov, ellers producerer den ene til noget den anden ikke trækker.
    applyPackingAdjustments,
    planShortfall,
    classifyProducedShortfall,
    consumeProduct,
    addToStock,
    addToStockFull,
    produceBatch,
    setInventory,
    updateProductUserfields,
    addToShoppingList,
    // Write — products + meta
    createProduct,
    createQuConversion,
    deleteQuConversion,
    getUserfields,
    // Indkøbsliste — udvidede endpoints
    getShoppingList,
    deleteShoppingListItem,
    addShoppingListProduct,
    removeShoppingListProduct,
    addMissingProducts,
    addExpiredProducts,
    addOverdueProducts,
    clearShoppingList,
    getShoppingLocations,
    getProductBarcodes,
    createProductBarcode,
    updateProductBarcode,
    updateProductBarcodeUserfields,
    updateProduct,
    deleteProduct,
    deleteProductBarcode,
    updateShoppingListItem,
    // Cache
    clearCache,
    invalidateRecipeCost,
    invalidateAllRecipeCosts,
    // Config (intern, men brugt af test-endpoint)
    getGrocyConfig,
};
