/**
 * Embed-bestillingsformular — public endpoints
 *
 * GET /embed/bestilling           — selve formen (HTML, indlejres i WordPress iframe)
 * GET /embed/config               — config (cutoff, leveringszoner, base-koordinat) som JSON
 * GET /embed/menus/:id.json       — menu-data (læses fra settings-tabellen)
 *
 * Sætter CSP frame-ancestors så iframen kun kan indlejres fra ristetrug.dk.
 */

const express = require('express');
const path = require('path');
const router = express.Router();
const { getDb } = require('../db/database');
const { todayISO } = require('../db/helpers');
const grocyAdapter = require('../services/grocyAdapter');

const ALLOWED_MENUS = ['standard']; // udvides når flere menuer kommer

/**
 * Map Grocy-recipes til embed-menu format.
 * Bruger eksisterende userfields:
 *   - sellable=1 (allerede filtreret af grocyAdapter.getRecipes())
 *   - grupper → category-navn
 * Bruger nye optionelle userfields (graceful hvis de ikke findes):
 *   - bestil_tags     (CSV: "vegan,gf") → tags-array
 *   - bestil_allergens (fri tekst) → allergens-streng
 *   - bestil_skjul     ("1" = skjul fra embed-formen, men sellable i øvrigt)
 */
function buildCategoryId(name) {
    return String(name || 'andet')
        .toLowerCase()
        .replace(/[æøå]/g, c => ({ 'æ': 'ae', 'ø': 'oe', 'å': 'aa' }[c]))
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'andet';
}

async function buildMenuFromGrocy(menuId) {
    const recipes = await grocyAdapter.getRecipes();
    // Hent rå userfields for de optionelle bestil_*-felter (getRecipes returnerer kun det normaliserede subset)
    const raw = await grocyAdapter.getRecipesRaw();
    const ufById = {};
    for (const r of raw) ufById[r.id] = r.userfields || {};

    const categoriesMap = new Map(); // name → id
    const items = [];

    for (const r of recipes) {
        const uf = ufById[r.id] || {};
        if (String(uf.bestil_skjul) === '1') continue;

        const catName = r.category || 'Andet';
        if (!categoriesMap.has(catName)) {
            categoriesMap.set(catName, buildCategoryId(catName));
        }
        const categoryId = categoriesMap.get(catName);

        const tagsRaw = uf.bestil_tags || '';
        const tags = String(tagsRaw)
            .split(',')
            .map(s => s.trim().toLowerCase())
            .filter(Boolean);

        items.push({
            id: 'r' + r.id,
            name: r.name,
            category: categoryId,
            tags,
            allergens: String(uf.bestil_allergens || '').trim(),
            active: true
        });
    }

    // Brug Grocy's sortering (allerede sorteret per category + name i getRecipes)
    const categories = Array.from(categoriesMap.entries()).map(([name, id]) => ({ id, name }));

    return {
        menu_id: menuId,
        name: 'Standard menu (Grocy)',
        version: new Date().toISOString().slice(0, 10),
        source: 'grocy',
        categories,
        items
    };
}

// CSP — tillad embed kun fra ristetrug.dk (kun på selve HTML-siden)
function setFrameHeaders(res) {
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://ristetrug.dk https://www.ristetrug.dk"
  );
  res.removeHeader('X-Frame-Options');
}

// ─── GET /embed/bestilling ─────────────────────────────────────────────────
router.get('/bestilling', (req, res) => {
  setFrameHeaders(res);
  const menuId = req.query.menu || 'standard';
  if (!ALLOWED_MENUS.includes(menuId)) {
    return res.redirect('/embed/bestilling?menu=standard');
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'embed', 'bestilling.html'));
});

// ─── GET /embed/config ─────────────────────────────────────────────────────
// Eksponerer KUN bestilling.* keys — aldrig hele settings-tabellen
router.get('/config', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT key, value FROM settings WHERE key LIKE 'bestilling.%'
  `).all();

  const config = {
    base: { lat: null, lon: null },
    cutoff: { time: 12, leadDays: 1, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
    delivery: null,
    deliveryDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
    // Hastebestilling: åbnes manuelt i Settings og gælder KUN den dato den blev sat.
    // Gemmes som ISO-dato (bestilling.cutoff_override_date); når den ikke længere
    // matcher dagens danske dato falder alt automatisk tilbage til normal cut-off.
    cutoffOverride: false,
  };

  for (const r of rows) {
    switch (r.key) {
      case 'bestilling.base_lat':
        config.base.lat = parseFloat(r.value);
        break;
      case 'bestilling.base_lon':
        config.base.lon = parseFloat(r.value);
        break;
      case 'bestilling.cutoff_time':
        config.cutoff.time = parseInt(r.value, 10);
        break;
      case 'bestilling.cutoff_lead_days':
        config.cutoff.leadDays = parseInt(r.value, 10);
        break;
      case 'bestilling.cutoff_days':
        config.cutoff.days = r.value.split(',').map(s => s.trim()).filter(Boolean);
        break;
      case 'bestilling.delivery_days':
        config.deliveryDays = r.value.split(',').map(s => s.trim()).filter(Boolean);
        break;
      case 'bestilling.delivery_config':
        try { config.delivery = JSON.parse(r.value); } catch (e) { config.delivery = null; }
        break;
      case 'bestilling.cutoff_override_date':
        // Aktiv kun hvis den gemte dato er dagens danske dato. Selv-nulstillende.
        config.cutoffOverride = (r.value || '').trim() === todayISO();
        break;
    }
  }

  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(config);
});

// ─── GET /embed/grocy-preview ─────────────────────────────────────────────
// Tvunget Grocy-render uanset menu_source-setting. Bruges af Settings UI til
// import-flow ("Importér fra Grocy"). Kræver login (session) for at undgå at
// public-iframe kan misbruge det til at omgå menu_source-valget.
router.get('/grocy-preview', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'auth_required' });
  try {
    const menu = await buildMenuFromGrocy('standard');
    res.setHeader('Cache-Control', 'no-store');
    res.json(menu);
  } catch (e) {
    console.error('[embed/grocy-preview]', e.message);
    res.status(502).json({ error: 'grocy_unavailable', detail: e.message });
  }
});

// ─── GET /embed/menus/:id.json ─────────────────────────────────────────────
router.get('/menus/:id.json', async (req, res) => {
  const id = req.params.id;
  if (!ALLOWED_MENUS.includes(id)) {
    return res.status(404).json({ error: 'menu_not_found' });
  }
  const db = getDb();
  const sourceRow = db.prepare("SELECT value FROM settings WHERE key = 'bestilling.menu_source'").get();
  const source = sourceRow?.value || 'manual';

  // ─── Grocy-mode ───
  if (source === 'grocy') {
    try {
      const menu = await buildMenuFromGrocy(id);
      menu.source = 'grocy';
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.json(menu);
    } catch (e) {
      console.error(`[embed/menus/${id}] Grocy-fejl:`, e.message);
      // Fallback til manual hvis Grocy er nede — bedre end at vise tom menu
    }
  }

  // ─── Manuel mode (eller fallback) ───
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(`bestilling.menu_${id}`);
  if (!row) {
    return res.status(404).json({ error: 'menu_not_configured' });
  }

  let menu;
  try {
    menu = JSON.parse(row.value);
  } catch (e) {
    console.error(`[embed/menus/${id}] Ugyldig JSON i settings:`, e.message);
    return res.status(500).json({ error: 'menu_invalid_json' });
  }
  menu.source = 'manual';
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(menu);
});

module.exports = router;
