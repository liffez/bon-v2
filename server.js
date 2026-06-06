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

app.use(express.static(path.join(__dirname)));

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
app.use('/api/cvr',        require('./routes/cvr'));
app.use('/api/settings',   require('./routes/settings'));
app.use('/api/wage-rates', require('./routes/wage_rates'));
app.use('/api/role-map',   require('./routes/role_map'));
app.use('/api/drift',      require('./routes/drift'));
app.use('/api/grocy',          require('./routes/grocy'));
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
app.use('/api/schedule',         require('./routes/schedule'));
app.use('/api/help-content',     require('./routes/help'));
app.use('/api/sidekick',         require('./routes/sidekick'));
app.use('/api/booking',          bookingRouter);
app.use('/api/delivery',         require('./routes/delivery'));
app.use('/delivery',             require('./routes/delivery_views'));
app.use('/api/nav',              require('./routes/nav'));

// Statisk serving af receipt-fotos (for Whiteboard link-only access)
app.use('/uploads/receipts', express.static(path.join(__dirname, 'data', 'uploads', 'receipts')));

// Statisk serving af CVR review-data (kun JSON-filer i data/)
app.use('/data', express.static(path.join(__dirname, 'data'), { extensions: ['json'] }));

// ─── MAIL POLLING ───────────────────────────────────────────────────────────

const { startPolling } = require('./services/mailService');
startPolling().catch(err => console.error('[mail] Polling fejl ved opstart:', err.message));


// ─── START ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    const { clientCount } = require('./shared/sse');
    const { getDb } = require('./db/database');
    const db = getDb();
    const bonCount    = db.prepare(`SELECT COUNT(*) as n FROM bons`).get().n;
    const todayCount  = db.prepare(`SELECT COUNT(*) as n FROM bons b JOIN status_definitions sd ON b.status_id = sd.id WHERE b.delivery_date = ? AND sd.code NOT IN ('AFLYST','FAKTURERET','BETALT','AFSLUTTET')`)
        .get(new Date().toISOString().slice(0, 10)).n;

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
