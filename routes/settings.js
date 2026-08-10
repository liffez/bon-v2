const express    = require('express');
const router     = express.Router();
const { getDb }  = require('../db/database');
const { handle, getUserId, invalidateUnitCountCache, todayISO } = require('../db/helpers');
const { requireAuth, invalidatePermCache } = require('../shared/auth');

// ─── ADGANG ────────────────────────────────────────────────────────────────
// Der findes INGEN global auth-gate i server.js — hver router sætter sin egen,
// og denne fil havde ingen. settings-tabellen styrer SMTP, webhook-secrets,
// nummerserier, session-varigheder og lagertræk, så ubeskyttet er den et angreb
// på driften, ikke bare en informationslækage.
//
// Model: admin som standard. Nogle få nøgler skrives af almindelige brugere fra
// deres eget view (køkkenets pris-toggle, CRM-listernes tærskler) — de står
// eksplicit herunder. Alt andet kræver admin. Ny bruger-justerbar indstilling
// ⇒ tilføj nøglen her BEVIDST; glemmes det, fejler den lukket (403), ikke åbent.
const USER_WRITABLE_SETTINGS = new Set([
    'show_prices_in_planning',      // shared/planning.js — køkkenets pris-toggle
    'reactivation_min_orders',      // office/views/crm-reaktivering.js + ringeliste
    'reactivation_quarantine_days', // do.
    'prospect_fit_w_branch',        // office/views/crm-prospekter.js
    'prospect_fit_w_size',          // do.
    'prospect_distance_min_km',     // do.
    'prospect_distance_max_km',     // do.
    'prospect_branch_blacklist',    // do.
]);

// GET /api/settings
// requireAuth() (ikke admin): alle inde-loggede zoner læser herfra ved init.
router.get('/', requireAuth(), handle((req, res) => {
    res.json(getDb().prepare(`SELECT key, value, description FROM settings`).all());
}));

// GET /api/settings/delivery-icons — parset JSON, public (alle inde-loggede)
//
// Returnerer { bike: {icon, label}, taxi: {...}, ... }. Frontends bruger denne
// til at vise leveringsmetode-ikoner ét sted, så ikoner kan ændres uden kode-deploy.
router.get('/delivery-icons', requireAuth(), handle((req, res) => {
    const row = getDb().prepare(`SELECT value FROM settings WHERE key='delivery_method_icons'`).get();
    if (!row) return res.json({});
    try {
        res.json(JSON.parse(row.value));
    } catch {
        res.json({});
    }
}));

// GET /api/settings/locations
router.get('/locations', requireAuth(), handle((req, res) => {
    const rows = getDb().prepare('SELECT id, name, code, grocy_api_url, address, is_active FROM locations ORDER BY id').all();
    res.json(rows);
}));

// GET /api/settings/inventory-status — er lagertrækket i live?
//
// Baggrund (#305): inventory_auto_deduct har stået på '0' siden v1→v2-cutoveret,
// så LEVERET har ikke trukket lager. Koden fejlede ikke — flaget gjorde præcis
// hvad der stod. Fejlen var at INGEN KUNNE SE at det var holdt op med at virke:
// bon-siden sagde "varer brugt", Grocy sagde "intet forlod huset", og de to tal
// mødtes aldrig noget sted.
//
// Endpointet er svaret på det. Det bruger bevidst KUN Bons egne tal — ingen
// Grocy-afhængighed, så visningen også virker når Grocy er nede (og en Grocy der
// er nede er netop et tidspunkt hvor man vil vide om trækket kører).
//
//   last_deducted_at  NULL = der er aldrig trukket. Se det, og du ved besked.
//
// To vinduer, fordi spørgsmålet skifter med flagets tilstand:
//
//   FRA  → "hvor meget skylder lageret?" Det er den ophobede skade, og den er
//          historisk: 90 dage.
//   TIL  → "virker det NU?" Historikken er irrelevant — de gamle bons trækker
//          ikke med tilbagevirkende kraft, og et 90-dages-tal ville stå og lyse
//          i tre måneder efter problemet var løst. Det er præcis den slags larm
//          folk lærer at ignorere. Derfor et kort vindue: har en bon leveret i
//          går ikke trukket, er DET en levende fejl.
// GET /api/settings/internal-senders
// Hvem tæller lige nu som "os selv" i mail-routingen? Reglen er usynlig i sig
// selv — den viser sig først som en mail der ikke havnede hvor man ventede.
// Derfor listes de kunderækker den rent faktisk rammer, med begrundelse.
router.get('/internal-senders', requireAuth('admin'), handle((req, res) => {
    const db = getDb();
    const { getInternalEntries, isInternalEmail } = require('../services/internalIdentity');
    const entries = getInternalEntries(db);

    // Kun kunder MED en email kan rammes af reglen — resten er irrelevante her.
    const rows = db.prepare(`
        SELECT c.id, c.first_name, c.last_name, c.email, co.name AS company_name,
               COALESCE(co.is_internal, 0) AS company_internal
          FROM customers c
          LEFT JOIN companies co ON co.id = c.company_id
         WHERE c.email IS NOT NULL AND TRIM(c.email) <> ''
    `).all();

    const matched = rows
        .filter(r => isInternalEmail(db, r.email))
        .map(r => ({
            id: r.id,
            name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.email,
            email: r.email,
            company_name: r.company_name || null,
            reason: r.company_internal ? 'firma markeret internt' : 'domæne/adresse på listen',
        }))
        .sort((a, b) => a.email.localeCompare(b.email));

    res.json({ entries, matched });
}));

router.get('/inventory-status', requireAuth(), handle((req, res) => {
    const db = getDb();
    const DELIVERED = `('LEVERET','FAKTURERET','BETALT','AFSLUTTET')`;

    const countSince = days => db.prepare(`
        SELECT COUNT(*) AS delivered,
               SUM(CASE WHEN COALESCE(b.inventory_deducted, 0) = 0 THEN 1 ELSE 0 END) AS undeducted
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE sd.code IN ${DELIVERED}
          AND COALESCE(b.is_offer, 0) = 0
          AND b.delivery_date >= date('now', '-${days} days')
    `).get();

    const flag   = db.prepare(`SELECT value FROM settings WHERE key='inventory_auto_deduct'`).get();
    const last   = db.prepare(`SELECT MAX(inventory_deducted_at) AS t FROM bons WHERE inventory_deducted = 1`).get();
    const hist   = countSince(90);
    const recent = countSince(7);

    res.json({
        enabled:          flag?.value === '1',
        flag_value:       flag?.value ?? null,
        last_deducted_at: last?.t ?? null,
        delivered_count:  hist?.delivered ?? 0,
        undeducted_count: hist?.undeducted ?? 0,
        window_days:      90,
        recent_delivered:  recent?.delivered ?? 0,
        recent_undeducted: recent?.undeducted ?? 0,
        recent_window_days: 7,
    });
}));

// POST /api/settings/locations/:id/test-grocy — test forbindelse til en specifik lokation
router.post('/locations/:id/test-grocy', requireAuth('admin'), handle(async (req, res) => {
    const { getGrocyConfig } = require('../services/grocyAdapter');
    const locId = parseInt(req.params.id);
    let url, key, locationName;
    try {
        ({ url, key, locationName } = getGrocyConfig(locId));
    } catch (e) {
        return res.status(400).json({ ok: false, error: e.message });
    }
    try {
        const base = url.replace(/\/+$/, '');
        const r = await fetch(base + '/system/info', {
            headers: { 'GROCY-API-KEY': key, 'Accept': 'application/json' },
        });
        if (!r.ok) {
            return res.json({ ok: false, status: r.status, error: 'HTTP ' + r.status });
        }
        const info = await r.json();
        res.json({ ok: true, version: info.grocy_version?.Version || 'ukendt', locationName });
    } catch (e) {
        res.json({ ok: false, error: e.message });
    }
}));

// PATCH /api/settings/:key
// requireAuth() fanger uautentificerede kald; rolle-tjekket sker pr. nøgle
// nedenfor, fordi requireAuth('admin') ville lukke køkkenets pris-toggle ude.
router.patch('/:key', requireAuth(), handle((req, res) => {
    if (!USER_WRITABLE_SETTINGS.has(req.params.key) && req.session?.userRole !== 'admin') {
        return res.status(403).json({ error: 'Kun admin kan ændre denne indstilling' });
    }
    const { value } = req.body;

    // Fakturavagtens skæringsdato må ikke kunne tømmes ved et uheld: uden dato
    // lyser vagten på hele v1-historikken og bliver ubrugelig. Ryd hellere med
    // et bevidst valg af dato end med et tomt felt.
    if (req.params.key === 'invoice_guard_from_date'
        && !require('../services/invoiceGuard').isValidGuardDate(value)) {
        return res.status(400).json({
            error: 'Skæringsdatoen skal være en gyldig dato (YYYY-MM-DD). '
                 + 'Vagten kan ikke køre uden — sæt den til dagen e-conomic-rutinen startede.'
        });
    }

    getDb().prepare(`INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`).run(req.params.key, value, value);
    // Invalidér cache for helpers der læser settings ved hver bon-recalc + genopbyg
    // recipe_unit_counts (enheds-kategorier/extra-recipes påvirker boks-tællingen).
    if (req.params.key === 'unit_count_categories' || req.params.key === 'unit_count_extra_recipes') {
        invalidateUnitCountCache();
        require('../services/recipeUnits').refreshRecipeUnitCountsSafe(getDb(), 'settings');
    }
    // Fakturavagtens skæringsdato caches i 60s — ryd den så ændringen slår igennem straks.
    if (req.params.key === 'invoice_guard_from_date') {
        require('../services/invoiceGuard').invalidateGuardCache();
    }
    // Interne afsendere afgør hvor indgående mail lander — en ændring skal virke
    // ved næste polling, ikke først når 60s-cachen udløber.
    if (req.params.key === 'internal_mail_domains' || req.params.key === 'mail_domain') {
        require('../services/internalIdentity').invalidateInternalCache();
    }
    res.json({ key: req.params.key, value });
}));

/* ── Rollerettigheder (admin) ────────────────────────── */

// GET /api/settings/role-permissions
router.get('/role-permissions', requireAuth('admin'), handle((req, res) => {
    const db = getDb();
    const roles = ['admin', 'office', 'kitchen', 'kitchen_personal', 'delivery'];
    const result = {};
    roles.forEach(role => {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?')
            .get(`role_permissions_${role}`);
        try { result[role] = row ? JSON.parse(row.value) : {}; }
        catch { result[role] = {}; }
    });
    res.json(result);
}));

// PATCH /api/settings/role-permissions/:role
router.patch('/role-permissions/:role', requireAuth('admin'), handle((req, res) => {
    const VALID_ROLES = ['office', 'kitchen', 'kitchen_personal', 'delivery'];
    if (!VALID_ROLES.includes(req.params.role)) {
        return res.status(400).json({ error: 'Ugyldig rolle eller admin kan ikke begrænses' });
    }
    const db = getDb();
    db.prepare(
        'UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?'
    ).run(JSON.stringify(req.body), `role_permissions_${req.params.role}`);

    invalidatePermCache();
    res.json({ ok: true });
}));

/* ── Duplikat-kandidater ───────────────────────────────
 * requireAuth() (ikke admin): kaldes fra shared/indkob_settings.js, der er
 * monteret både i køkkenets ⚙-panel og i office' Indkøb-fane. Overskriften
 * sagde "(admin)", men ruterne har aldrig håndhævet det — og gør det stadig
 * ikke, for det ville lukke køkkenet ude af duplikat-tabben. */

// GET /api/settings/duplicates
router.get('/duplicates', requireAuth(), handle((req, res) => {
    const db = getDb();
    const status = req.query.status || 'pending';
    const rows = db.prepare(`
        SELECT * FROM duplicate_candidates
        WHERE status = ?
        ORDER BY created_at DESC
    `).all(status);
    res.json(rows);
}));

// GET /api/settings/duplicates/all
router.get('/duplicates/all', requireAuth(), handle((req, res) => {
    const db = getDb();
    const rows = db.prepare(`
        SELECT * FROM duplicate_candidates
        ORDER BY status, created_at DESC
    `).all();
    res.json(rows);
}));

// POST /api/settings/duplicates — log nyt duplikat-fund
router.post('/duplicates', requireAuth(), handle((req, res) => {
    const db = getDb();
    const { product_id_a, product_name_a, product_id_b, product_name_b, barcode, barcode_name } = req.body;

    // Tjek om dette par allerede er logget
    const existing = db.prepare(`
        SELECT id FROM duplicate_candidates
        WHERE ((product_id_a = ? AND product_id_b = ?) OR (product_id_a = ? AND product_id_b = ?))
          AND barcode = ?
    `).get(product_id_a, product_id_b, product_id_b, product_id_a, barcode);

    if (existing) {
        return res.json({ ok: true, id: existing.id, already_logged: true });
    }

    const result = db.prepare(`
        INSERT INTO duplicate_candidates (product_id_a, product_name_a, product_id_b, product_name_b, barcode, barcode_name)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(product_id_a, product_name_a || null, product_id_b, product_name_b || null, barcode, barcode_name || null);

    res.json({ ok: true, id: result.lastInsertRowid });
}));

// PATCH /api/settings/duplicates/:id — opdater status
router.patch('/duplicates/:id', requireAuth(), handle((req, res) => {
    const db = getDb();
    const { status, notes } = req.body;
    const userId = getUserId(req);

    db.prepare(`
        UPDATE duplicate_candidates
        SET status = ?, notes = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by_user_id = ?
        WHERE id = ?
    `).run(status, notes || null, userId, parseInt(req.params.id));

    res.json({ ok: true });
}));

/* ── Bestilling: menu CRUD (admin) ────────────────────── */

const ALLOWED_MENU_IDS = ['standard'];

// GET /api/settings/bestilling/menu/:id — hent menu-JSON parsed
router.get('/bestilling/menu/:id', requireAuth('admin'), handle((req, res) => {
    const id = req.params.id;
    if (!ALLOWED_MENU_IDS.includes(id)) {
        return res.status(404).json({ error: 'menu_not_allowed' });
    }
    const row = getDb().prepare(
        'SELECT value FROM settings WHERE key = ?'
    ).get(`bestilling.menu_${id}`);
    if (!row) return res.status(404).json({ error: 'menu_not_found' });

    try {
        res.json(JSON.parse(row.value));
    } catch (e) {
        res.status(500).json({ error: 'menu_invalid_json', detail: e.message });
    }
}));

// PUT /api/settings/bestilling/menu/:id — gem menu-JSON med validering
router.put('/bestilling/menu/:id', requireAuth('admin'), handle((req, res) => {
    const id = req.params.id;
    if (!ALLOWED_MENU_IDS.includes(id)) {
        return res.status(404).json({ error: 'menu_not_allowed' });
    }

    const menu = req.body;
    if (!menu || typeof menu !== 'object') {
        return res.status(400).json({ error: 'invalid_payload' });
    }
    if (!Array.isArray(menu.categories) || !Array.isArray(menu.items)) {
        return res.status(400).json({ error: 'missing_categories_or_items' });
    }

    // Valider kategori-ids
    const catIds = new Set();
    for (const c of menu.categories) {
        if (!c.id || !c.name) return res.status(400).json({ error: 'category_missing_id_or_name' });
        if (catIds.has(c.id)) return res.status(400).json({ error: 'duplicate_category_id', id: c.id });
        catIds.add(c.id);
    }

    // Valider items
    const itemIds = new Set();
    for (const it of menu.items) {
        if (!it.id || !it.name) return res.status(400).json({ error: 'item_missing_id_or_name' });
        if (itemIds.has(it.id)) return res.status(400).json({ error: 'duplicate_item_id', id: it.id });
        if (!catIds.has(it.category)) return res.status(400).json({ error: 'item_unknown_category', id: it.id, category: it.category });
        itemIds.add(it.id);
    }

    // Auto-bump version + sæt menu_id
    menu.menu_id = id;
    // Dansk kalenderdato, ikke UTC (#133): en menu gemt efter midnat dansk tid
    // fik ellers gårsdagens versionsstempel. routes/embed.js:84 stempler samme
    // felt med todayISO() — de to skal være enige.
    menu.version = todayISO();

    const json = JSON.stringify(menu);
    getDb().prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP'
    ).run(`bestilling.menu_${id}`, json, json);

    res.json({ ok: true, version: menu.version });
}));

module.exports = router;
