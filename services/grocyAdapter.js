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
const { getDefaultLocationId } = require('../db/helpers');

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
 * Hent Grocy-konfiguration for standard-lokationen.
 *
 * 1. Læs default_grocy_location_id fra settings → fallback: første aktive lokation
 * 2. Hent grocy_api_url + grocy_api_key fra locations
 * 3. Hvis api_key er tom → fallback til process.env.GROCY_HQ_KEY
 */
function getGrocyConfig() {
    const db = getDb();

    // Find lokation-id
    const setting = db.prepare(`SELECT value FROM settings WHERE key = 'default_grocy_location_id'`).get();
    const locationId = setting ? parseInt(setting.value) : getDefaultLocationId();

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
        throw new Error(`Lokation "${loc.name}" mangler grocy_api_key (og GROCY_HQ_KEY er ikke sat i .env).`);
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
    return result;
}

/** Opdater userfields på opskrift */
async function updateRecipeUserfields(id, fields) {
    const result = await grocyPut(`/userfields/recipes/${id}`, fields);
    _cache.delete('recipes');
    return result;
}

/** Opret ingrediens-position */
async function createRecipePos(body) {
    const result = await grocyPost('/objects/recipes_pos', body);
    _cache.delete('all_recipes_pos');
    _cache.delete(`recipe_ing_${body.recipe_id}`);
    return result;
}

/** Opdater ingrediens-position */
async function updateRecipePos(id, body) {
    const result = await grocyPut(`/objects/recipes_pos/${id}`, body);
    _cache.delete('all_recipes_pos');
    return result;
}

/** Slet ingrediens-position */
async function deleteRecipePos(id) {
    const result = await grocyDelete(`/objects/recipes_pos/${id}`);
    _cache.delete('all_recipes_pos');
    return result;
}

/** Opret underopskrift-relation */
async function createRecipeNesting(body) {
    const result = await grocyPost('/objects/recipes_nestings', body);
    _cache.delete('recipes_nestings');
    return result;
}

/** Opdater underopskrift-relation */
async function updateRecipeNesting(id, body) {
    const result = await grocyPut(`/objects/recipes_nestings/${id}`, body);
    _cache.delete('recipes_nestings');
    return result;
}

/** Slet underopskrift-relation */
async function deleteRecipeNesting(id) {
    const result = await grocyDelete(`/objects/recipes_nestings/${id}`);
    _cache.delete('recipes_nestings');
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
 * Opskrifter transformeret til picker-format.
 * Filtrerer til sellable=1 og mapper userfields til struktureret objekt.
 */
async function getRecipes() {
    const [raw, fulfillment] = await Promise.all([getRecipesRaw(), getRecipeFulfillment()]);
    // Build lookup: recipe_id → calculated costs from Grocy fulfillment
    const costMap = {};
    for (const f of fulfillment) {
        costMap[f.recipe_id] = f.costs || 0;
    }
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
                cost_price: costMap[r.id] ?? (parseFloat(uf.costprice) || 0),
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
 * Forbruger ingredienser fra Grocy-lager for en liste bon-linjer.
 *
 * Ny tilgang (erstatter gammel recipe-level consume):
 * 1. Resolver ALLE ingredienser inkl. underopskrifter via ingredientResolver
 * 2. Aggregerer per product_id (inkl. emballage)
 * 3. Kalder POST /stock/products/{id}/consume per produkt
 * 4. Returnerer per-produkt results (partial success ved fejl)
 *
 * @param {Array<{grocy_recipe_id: number, quantity: number}>} lines  Bon-linjer
 * @returns {Array<{product_id: number, product_name: string, amount: number, success: boolean, error?: string}>}
 */
async function consumeRecipes(lines) {
    const validLines = lines.filter(l => l.grocy_recipe_id);
    if (!validLines.length) return [];

    // Lazy require for at undgå cirkulær dependency
    const { resolveConsumeItems } = require('./ingredientResolver');

    let items;
    try {
        items = await resolveConsumeItems(validLines);
    } catch (err) {
        console.error('[consume] Fejl ved ingredient-opløsning:', err);
        return [{ product_id: 0, product_name: '(resolver fejl)', amount: 0, success: false, error: err.message }];
    }

    if (!items.length) return [];

    // ── Stock-snapshot: behov for partial-consume + auto-shopping-list ──
    //
    // For hvert produkt skal vi vide hvor meget der ER på lager. Det er ikke trivielt
    // pga. parent-produkter: en parent har selv stock_amount=0, men dens børn har
    // stock (kål = Hvidkål + Spidskål). Vi bygger derfor en helper der finder den
    // effektive samlede stock for et produkt (sum over familie hvis det er en parent).
    let stock = [];
    let products = [];
    try {
        [stock, products] = await Promise.all([getStock(), getProducts()]);
    } catch (err) {
        console.warn('[consume] Kunne ikke hente stock/products til partial-check:', err.message);
        // Fortsæt uden partial-logik — fallback til simple consume
    }
    const stockByPid = new Map();
    for (const s of stock) stockByPid.set(parseInt(s.product_id), parseFloat(s.amount) || 0);

    // For parent: sum over alle børns stock. For ikke-parent: bare egen stock.
    const childrenByParent = new Map();
    for (const p of products) {
        if (p.parent_product_id) {
            const par = parseInt(p.parent_product_id);
            if (!childrenByParent.has(par)) childrenByParent.set(par, []);
            childrenByParent.get(par).push(parseInt(p.id));
        }
    }
    function effectiveStock(pid) {
        const ownStock = stockByPid.get(pid) || 0;
        const kids = childrenByParent.get(pid) || [];
        if (kids.length === 0) return ownStock;
        let sum = ownStock;
        for (const kid of kids) sum += stockByPid.get(kid) || 0;
        return sum;
    }

    // ── Consume hvert produkt med partial-fallback + shopping-list-add ──
    //
    // Replikerer Bon v1's adfærd: når der ikke er nok lager til at dække behovet,
    // trækker vi det der ER på lageret (partial), og lægger en hel purchase-enhed
    // på Grocy's shopping_list så indkøb sker næste gang. Uden dette ender bonnen
    // som "trukket" (inventory_deducted=1) selvom intet faktisk blev konsumeret.
    const results = [];
    for (const item of items) {
        const needed   = item.amount_stock;
        const available = effectiveStock(item.product_id);
        const toConsume = Math.min(needed, available);
        const shortfallStock = Math.max(0, needed - available);
        const FLOAT_TOL = 0.001;

        // Trin 1: consume det vi kan (kan være 0 hvis lager er tomt)
        if (toConsume > FLOAT_TOL) {
            try {
                await grocyPost(`/stock/products/${item.product_id}/consume`, {
                    amount:           toConsume,
                    transaction_type: 'consume',
                    spoiled:          false,
                    // Parent-produkter (fx "Kål") har stock=0 men kan substitueres af
                    // børn med stock (Spidskål, Hvidkål). Uden dette flag fejler consume
                    // med 400 "No transaction was found by the given transaction id".
                    allow_subproduct_substitution: true,
                });
            } catch (err) {
                // Stock-snapshot var måske stale — registrér som fejl men fortsæt
                results.push({
                    product_id:   item.product_id,
                    product_name: item.product_name,
                    amount:       toConsume,
                    success:      false,
                    error:        err.message,
                });
                continue;
            }
        }

        // Trin 2: hvis der mangler, læg purchase-enhed(er) på shopping list.
        // Bruger Grocys smart endpoint der DEDUPPER — samme product_id øger qty
        // på eksisterende entry i stedet for at oprette duplikat.
        let shortfallPurchase = 0;
        if (shortfallStock > FLOAT_TOL) {
            const factor = item.purchase_factor || 1;
            shortfallPurchase = Math.ceil(shortfallStock * factor);
            const noteText = `Auto-tilføjet ved LEVERET (manglede ${shortfallStock.toFixed(3)} fra consume)`;
            try {
                await addShoppingListProduct(item.product_id, shortfallPurchase, 1, noteText);
            } catch (err) {
                console.warn(`[consume] Kunne ikke tilføje pid=${item.product_id} til shopping list:`, err.message);
                // Ikke en hård fejl — consume lykkedes (delvist), shopping-list-add er ekstra
            }
        }

        results.push({
            product_id:         item.product_id,
            product_name:       item.product_name,
            amount:             toConsume,
            shortfall_stock:    shortfallStock,
            shortfall_purchase: shortfallPurchase,
            partial:            shortfallStock > FLOAT_TOL && toConsume > FLOAT_TOL,
            success:            true,
        });
    }

    // Ryd stock-cache efter forbrug
    _cache.delete('stock');
    _cache.delete('shopping_list');
    return results;
}

/**
 * Consume ét produkt fra Grocy-lager.
 * @param {number} productId  Grocy product ID
 * @param {number} amount     Mængde i stock-units
 */
async function consumeProduct(productId, amount) {
    await grocyPost(`/stock/products/${productId}/consume`, {
        amount,
        transaction_type: 'consume',
        spoiled: false,
        // Tillader parent-produkter (med stock=0) at substituere fra børn — se consumeRecipes
        allow_subproduct_substitution: true,
    });
    _cache.delete('stock');
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
    await grocyPost(`/stock/products/${productId}/add`, payload);
    _cache.delete('stock');
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
    await grocyPost(`/stock/products/${productId}/inventory`, body);
    _cache.delete('stock');
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
    getRecipesRawMap,
    getRecipeFulfillment,
    getRecipeIngredients,
    getRecipeNestings,
    getProducts,
    getStock,
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
    consumeProduct,
    addToStock,
    addToStockFull,
    setInventory,
    updateProductUserfields,
    addToShoppingList,
    // Write — products + meta
    createProduct,
    createQuConversion,
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
    deleteProductBarcode,
    updateShoppingListItem,
    // Cache
    clearCache,
};
