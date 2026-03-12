/**
 * services/grocyAdapter.js
 * ════════════════════════════════════════════════════════════
 * Readonly adapter til Grocy API.
 *
 * Eksporterer funktioner der kaldes fra routes/grocy.js.
 * Henter credentials fra locations-tabellen (med .env fallback).
 * In-memory cache med 10 min TTL.
 *
 * Bon v2 læser kun fra Grocy — skriver aldrig.
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
    // Fallback-kæde: locations-tabel → env pr. lokation (GROCY_<code>_KEY) → env HQ
    const envKey = `GROCY_${loc.code}_KEY`;
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

/* ══════════════════════════════════════════════════════════════
   EKSPORTEREDE FUNKTIONER
   ══════════════════════════════════════════════════════════════ */

/** Alle opskrifter */
function getRecipes() {
    return cachedFetch('recipes', '/objects/recipes');
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

/* ══════════════════════════════════════════════════════════════ */

module.exports = {
    getRecipes,
    getRecipeFulfillment,
    getRecipeIngredients,
    getProducts,
    getStock,
    clearCache,
};
