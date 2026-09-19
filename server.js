/**
 * Bon v2 — Backend Server
 * Node.js / Express / node:sqlite
 *
 * Start: node server.js
 */

require('dotenv').config({ quiet: true });

const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 4321;
const IS_PROD = process.env.NODE_ENV === 'production';

// Nginx sidder foran i produktion — tillad Express at se ægte protokol/IP
if (IS_PROD) app.set('trust proxy', 1);

// Uden COOKIE_DOMAIN bliver session-cookien host-only på bon.ristetrug.dk,
// og auth_request på whiteboard/sop/grocy-* subdomæner går i login-loop.
if (IS_PROD && !process.env.COOKIE_DOMAIN) {
  console.warn('[bon-v2] WARNING: NODE_ENV=production men COOKIE_DOMAIN er ikke sat — SSO på subdomæner vil fejle. Sæt COOKIE_DOMAIN=.ristetrug.dk i .env.');
}
if (IS_PROD && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'dev-secret-change-me')) {
  console.warn('[bon-v2] WARNING: SESSION_SECRET er ikke sat — sessioner invalideres ved hver restart. Generér en med: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
}

// ─── MIDDLEWARE ─────────────────────────────────────────────────────────────

// Limit hævet til 600kb: paste-flows (fx Firma 360° "Tilføj offentlige kontakter")
// annoncerer 500kb rå tekst, og JSON-escaping kan gøre payloaden lidt større.
app.use(express.json({ limit: '600kb' }));

// Body-parser fejl (for stor payload, ugyldig JSON) → ren JSON i stedet for
// Express' default HTML-svar, som frontendens apiFetch ikke kan parse (ville
// give en kryptisk "API fejl: 413" eller hænge).
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'Indholdet er for stort (max ~500 KB). Klistr en mindre del ind — fx kun footer/kontakt-sektionen.' });
  }
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'Kunne ikke læse forespørgslen (ugyldig JSON).' });
  }
  next(err);
});

const session = require('express-session');
const SqliteSessionStore = require('./db/session-store')(session);

app.use(session({
  store: new SqliteSessionStore({ db: 'sessions.db', dir: './db' }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    domain: process.env.COOKIE_DOMAIN || undefined
  }
}));

// Localhost-override: hvis .env har produktion-cookie-config (secure + domain)
// men requesten kommer fra localhost, slæk restriktionerne så browseren
// accepterer Set-Cookie. Ingen effekt i produktion.
app.use((req, res, next) => {
  const host = req.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (isLocal && req.session && req.session.cookie) {
    req.session.cookie.secure = false;
    req.session.cookie.domain = undefined;
  }
  next();
});

// ─── ROOT REDIRECT ─────────────────────────────────────────────────────────
// Redirect / til login eller default zone baseret på session

app.get('/', (req, res) => {
  if (req.session?.userId) {
    const role = req.session.userRole || 'kitchen';
    if (role === 'admin' || role === 'office') return res.redirect('/office/');
    if (role === 'kitchen_personal') return res.redirect('/mobile/');
    return res.redirect('/kitchen/');
  }
  res.redirect('/login.html');
});

/* ──────────────────────────────────────────────────────────────
   STATISK SERVERING

   Her stod `express.static(path.join(__dirname))` — HELE projektmappen,
   uden login. Det gjorde ikke bare frontend-koden offentlig, men også
   `routes/`, `services/`, `db/`, `utils/`, `scripts/` og `deploy/`.
   `.env` slap alene fri fordi express.static som standard ignorerer
   dotfiles; det var held, ikke design.

   Nu serveres kun de mapper browseren rent faktisk henter fra, plus de få
   løse filer i roden. En ny mappe i projektet er dermed lukket indtil nogen
   skriver den ind her — det er den rigtige vej rundt: man skal aktivt
   åbne noget, ikke huske at lukke det.
   ────────────────────────────────────────────────────────────── */
const PUBLIC_DIRS = [
    'assets',                                   // logo, ikoner, fonte, leaflet
    'shared',                                   // fælles JS/CSS på tværs af zoner
    'office', 'kitchen', 'mobile', 'settings',  // zone-shells
    'views',                                    // /views/delivery/note.{js,css} — leveringsvinduet
];
for (const dir of PUBLIC_DIRS) {
    app.use('/' + dir, express.static(path.join(__dirname, dir)));
}

// Løse filer i roden som siderne henter direkte. Alt andet i roden
// (package.json, CLAUDE.md, state-filer, arkiver) er ikke længere offentligt.
const PUBLIC_ROOT_FILES = ['login.html', 'favicon.ico', 'BonConfig.js', 'BonConfigBar.js'];
for (const file of PUBLIC_ROOT_FILES) {
    app.get('/' + file, (req, res) => res.sendFile(path.join(__dirname, file)));
}

// Kundevendte booking-sider. De lå i tools/ — og var dermed utilgængelige for
// præcis dem de er lavet til: /tools kom bag login med #581, og nginx på prod
// svarer 404 på /tools/ overhovedet. Linket i Settings pegede på en 404.
//
// De ligger nu i deres egen mappe med en offentlig sti, fordi det er dét de
// er: kundeflader. tools/ er arbejdsredskaber bag login, og en public side
// dér er en fælde der venter på næste gang nogen strammer adgangen.
const PUBLIC_BOOKING_PAGES = { smagning: 'smagning.html', kontakt: 'kontakt.html' };
for (const [slug, file] of Object.entries(PUBLIC_BOOKING_PAGES)) {
    app.get('/book/' + slug, (req, res) => res.sendFile(path.join(__dirname, 'booking', file)));
}

// ─── ROUTES ────────────────────────────────────────────────────────────────

// ─── WEB ORDER WEBHOOK (public, CORS for ristetrug.dk + test-origins) ───────
const webOrdersRouter = require('./routes/web-orders');
const WEBHOOK_ALLOWED_ORIGINS = [
  'https://www.ristetrug.dk',
  'https://ristetrug.dk',
  'https://bestil-form.netlify.app'
];
const bookingRouter = require('./routes/booking');
const webhookCors = (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && WEBHOOK_ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
};
app.use('/webhook', webhookCors, webOrdersRouter);
app.use('/webhook', webhookCors, bookingRouter);
app.use('/webhook', webhookCors, require('./routes/event-bridge'));

// ═══ GLOBAL AUTH-GATE PÅ /api ═══════════════════════════════════════════════
//
// Indtil nu satte hver router sin egen auth, og en router uden requireAuth var
// dermed helt åben for enhver der kunne nå serveren. Fejlen var ikke ondsindet,
// den var strukturel: at huske auth på hver ny rute er en tilstand man ikke kan
// holde, og en glemt rute fejlede ÅBENT.
//
// Denne gate vender det om: /api kræver login som standard. Glemmer nogen at
// tænke over adgang på en ny rute, fejler den nu LUKKET — man opdager det med
// det samme i stedet for om et år.
//
// Gaten erstatter IKKE requireAuth i routerne. Den sikrer kun "er du logget
// ind"; rolle-tjek (admin/office/...) hører fortsat hjemme i den enkelte rute,
// hvor konteksten er kendt.
//
// PUBLIC_API_PATHS er de eneste undtagelser. Listen er bevidst eksplicit og
// anker-bundet (^…$): en ny public rute skal tilføjes med vilje. `req.path` er
// her stien EFTER /api — dvs. '/api/auth/login' matches som '/auth/login'.
const PUBLIC_API_PATHS = [
    // Login-flowet — sider man per definition ser uden at være logget ind
    /^\/auth\/login$/,
    /^\/auth\/pin$/,
    /^\/auth\/pin-users$/,           // mobile/login.html: bruger-vælgeren før PIN

    // Kundevendt booking (booking/smagning.html + booking/kontakt.html → /book/*).
    // BEMÆRK: /booking/meeting-types/intent er sælger-værktøj og matcher IKKE
    // (anker $), så den fanges korrekt af gaten. Samme for /booking/admin/*.
    /^\/booking\/meeting-types$/,
    /^\/booking\/contact-reasons$/,
    /^\/booking\/slots$/,
    /^\/booking\/page-templates\/[^/]+$/,
    /^\/booking\/token\/[^/]+$/,

    // Test-runnernes mail-buffer. Ruten mountes kun når NODE_ENV='test', så
    // undtagelsen kan ikke nå produktion — men den står her for at være synlig.
    ...(process.env.NODE_ENV === 'test' ? [/^\/test(\/|$)/] : []),
];

const { requireAuth: _gateAuth } = require('./shared/auth');
app.use('/api', (req, res, next) => {
    if (PUBLIC_API_PATHS.some(re => re.test(req.path))) return next();
    return _gateAuth()(req, res, next);
});
// ════════════════════════════════════════════════════════════════════════════

// Web-ordre-listen. Mountes EFTER gaten (webhooken selv ligger på /webhook
// ovenfor og er upåvirket). Sidegevinst: aliaset /api/web-orders/bestilling —
// en utilsigtet public kopi af webhooken — er hermed lukket.
app.use('/api/web-orders', webOrdersRouter);

// Kort URL for booking-tokens — GET /b/:token → redirect til tools-side
app.use('/b', require('./routes/booking-redirect'));

// Embed-bestillingsformular (public, indlejres i WordPress iframe)
app.use('/embed', require('./routes/embed'));

// Test-only: eksponerer mailService's in-memory mail-buffer til test-runnere.
// Kun aktiv når NODE_ENV='test' (.env.test → test-server på port 4322).
if (process.env.NODE_ENV === 'test') {
    app.use('/api/test', require('./routes/test-mail'));
}

app.use('/api/auth',           require('./routes/auth'));
app.use('/api/payment-types',  require('./routes/payment_types'));
app.use('/api/sse',            require('./shared/sse'));
app.use('/api/bons',      require('./routes/kitchen'));   // /today matcher først
app.use('/api/bons',      require('./routes/bons'));
app.use('/api/events',    require('./routes/events'));
app.use('/api/statuses',  require('./routes/statuses'));
app.use('/api/customers',  require('./routes/customers'));
app.use('/api/companies',  require('./routes/companies'));
app.use('/api/contact-points', require('./routes/contact-points'));
app.use('/api/flags',      require('./routes/flags'));
app.use('/api/campaigns',  require('./routes/campaigns'));
app.use('/api/admin/merge-companies', require('./routes/admin-merge'));
app.use('/api/admin/batch-enrich', require('./routes/admin-batch-enrich'));
app.use('/api/admin/cleanup', require('./routes/admin-cleanup'));
app.use('/api/cvr',        require('./routes/cvr'));
app.use('/api/settings',   require('./routes/settings'));
app.use('/api/wage-rates', require('./routes/wage_rates'));
app.use('/api/role-map',   require('./routes/role_map'));
app.use('/api/drift',      require('./routes/drift'));
app.use('/api/pos',        require('./routes/pos'));
app.use('/api/grocy',          require('./routes/grocy'));
app.use('/api/co2',            require('./routes/co2'));
app.use('/api/smartplan',      require('./routes/smartplan'));
app.use('/api/notifications',  require('./routes/notifications'));
app.use('/api/price-categories', require('./routes/price_categories'));
app.use('/api/addresses',     require('./routes/addresses'));
app.use('/api/webhooks',      require('./routes/webhooks'));
app.use('/api/users',         require('./routes/users'));
app.use('/api/mail',          require('./routes/mail'));
app.use('/api/dashboard',    require('./routes/dashboard'));
app.use('/api/reports',      require('./routes/reports'));
// Opskrifter & priser — ét modul, to mounts (recipes + item-prices)
const recipesOverviewRouter = require('./routes/recipes_overview');
app.use('/api/recipes',      recipesOverviewRouter);
app.use('/api/item-prices',  recipesOverviewRouter.itemPricesRouter);
app.use('/api/cashflow',     require('./routes/cashflow'));
app.use('/api/crm',                require('./routes/crm'));
app.use('/api/rfm',                require('./routes/rfm'));
app.use('/api/activity-purposes',  require('./routes/activity-purposes'));
app.use('/api/invoices',           require('./routes/invoices'));
app.use('/api/quotes',       require('./routes/quotes'));
app.use('/api/horkram',      require('./routes/horkram'));
app.use('/api/purchasing',   require('./routes/purchasing'));
app.use('/api/orders',       require('./routes/orders'));
app.use('/api/receiving',    require('./routes/receiving'));
app.use('/api/attachments',      require('./routes/attachments'));
app.use('/api/staff',            require('./routes/staff'));
app.use('/api/goods-receipts',   require('./routes/goods-receipts'));
app.use('/api/production',       require('./routes/production'));
app.use('/api/physical-units',   require('./routes/physical-units'));
app.use('/api/stock-counts',     require('./routes/stock-counts'));
app.use('/api/schedule',         require('./routes/schedule'));
app.use('/api/help-content',     require('./routes/help'));
app.use('/api/sidekick',         require('./routes/sidekick'));
app.use('/api/booking',          bookingRouter);
app.use('/api/delivery',         require('./routes/delivery'));
app.use('/delivery',             require('./routes/delivery_views'));
app.use('/api/nav',              require('./routes/nav'));

// Statisk serving af receipt-fotos (for Whiteboard link-only access)
app.use('/uploads/receipts', express.static(path.join(__dirname, 'data', 'uploads', 'receipts')));

// CVR review-data til tools/cvr-review.html.
//
// Her stod `express.static('data', { extensions: ['json'] })`, og kommentaren
// sagde "kun JSON-filer". Det gør `extensions` ikke: den er en FALLBACK for
// URL'er UDEN endelse, ikke et filter. Hele data/ blev serveret som den lå —
// og `GET /data/bon.db` hentede produktionsdatabasen ned uden login.
//
// Nu: de to filer værktøjet bruger, og kun for den der er logget ind.
const CVR_REVIEW_FILES = new Set(['cvr-virk-review.json', 'cvr-unmatched.json']);
app.get('/data/:file', _gateAuth(), (req, res) => {
    if (!CVR_REVIEW_FILES.has(req.params.file)) return res.status(404).end();
    res.sendFile(path.join(__dirname, 'data', req.params.file));
});

// Interne værktøjssider (CVR-review m.fl.). De er arbejdsredskaber, ikke
// offentlige flader — og tools/horkram-opret-helper.html indeholder
// leverandørpriser. Derfor bag login, med redirect så en HTML-side lander
// på login i stedet for en rå 401.
app.use('/tools', (req, res, next) => {
    if (req.session?.userId) return next();
    res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl));
}, express.static(path.join(__dirname, 'tools')));

// ─── MAIL POLLING ───────────────────────────────────────────────────────────

const { startPolling } = require('./services/mailService');
startPolling().catch(err => console.error('[mail] Polling fejl ved opstart:', err.message));

// ─── VAGTPLAN-SPEJL (Smartplan) ─────────────────────────────────────────────
// Én ejer af hvornår vi taler med Smartplan. ALT læsning sker fra det lokale
// spejl, så hverken en SSE-drevet genindlæsning eller ti åbne skærme kan udløse
// udgående kald. Slår sig selv fra hvis smartplan_enabled = 0.
require('./services/smartplanSync').startScheduler();

// ─── POS-SYNK (Zettle) ──────────────────────────────────────────────────────
// Slår sig selv fra hvis zettle_enabled = 0 eller credentials mangler.
require('./services/posSync').startPolling();

// Opbyg recipe_unit_counts (boks-aware enheds-tælling) ved opstart — ikke-blokerende.
// Holder tabellen frisk efter Grocy-recipe-/nesting-ændringer mellem deploys.
const { refreshRecipeUnitCountsSafe } = require('./services/recipeUnits');
refreshRecipeUnitCountsSafe(require('./db/database').getDb(), 'startup')
    .then(n => n && console.log(`[recipeUnits] ${n} recipes mappet ved opstart`));


// ─── START ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    const { clientCount } = require('./shared/sse');
    const { getDb } = require('./db/database');
    const { todayISO } = require('./db/helpers');
    const db = getDb();
    const bonCount    = db.prepare(`SELECT COUNT(*) as n FROM bons`).get().n;
    const todayCount  = db.prepare(`SELECT COUNT(*) as n FROM bons b JOIN status_definitions sd ON b.status_id = sd.id WHERE b.delivery_date = ? AND sd.code NOT IN ('AFLYST','FAKTURERET','BETALT','AFSLUTTET')`)
        .get(todayISO()).n;

    console.log(`
╔══════════════════════════════════════════════════════╗
║  Bon v2 Server                                       ║
╠══════════════════════════════════════════════════════╣
║  http://localhost:${PORT}                                ║
╠──────────────────────────────────────────────────────╣
║  Views                                               ║
║    Køkken I Dag   /kitchen/today.html                ║
║    Køkken Senere  /kitchen/later.html                ║
║    Office         /office/index.html                 ║
║    Settings       /settings/index.html               ║
╠──────────────────────────────────────────────────────╣
║  API                                                 ║
║    GET  /api/bons/today      Dagens bonner           ║
║    GET  /api/bons            Alle bonner (filter)    ║
║    GET  /api/statuses        Statusser               ║
║    GET  /api/customers       Kunder                  ║
║    GET  /api/settings        Indstillinger           ║
║    GET  /api/grocy/*         Grocy proxy (readonly)  ║
║    GET  /api/sse             Server-Sent Events      ║
╠──────────────────────────────────────────────────────╣
║  Database                                            ║
║    Bonner i alt: ${String(bonCount).padEnd(5)}  I dag: ${String(todayCount).padEnd(20)}║
║    SSE-klienter: ${String(clientCount()).padEnd(36)}║
╚══════════════════════════════════════════════════════╝`);
});
