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

// ─── MIDDLEWARE ─────────────────────────────────────────────────────────────

app.use(express.json());

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
    sameSite: 'lax'
  }
}));

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

// ─── WEB ORDER WEBHOOK (public, CORS for ristetrug.dk) ─────────────────────
const webOrdersRouter = require('./routes/web-orders');
app.use('/webhook', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin === 'https://www.ristetrug.dk' || origin === 'https://ristetrug.dk') {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-webhook-secret');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}, webOrdersRouter);
app.use('/api/web-orders', webOrdersRouter);

app.use('/api/auth',           require('./routes/auth'));
app.use('/api/payment-types',  require('./routes/payment_types'));
app.use('/api/sse',            require('./shared/sse'));
app.use('/api/bons',      require('./routes/kitchen'));   // /today matcher først
app.use('/api/bons',      require('./routes/bons'));
app.use('/api/statuses',  require('./routes/statuses'));
app.use('/api/customers',  require('./routes/customers'));
app.use('/api/companies',  require('./routes/companies'));
app.use('/api/cvr',        require('./routes/cvr'));
app.use('/api/settings',   require('./routes/settings'));
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
app.use('/api/crm',          require('./routes/crm'));
app.use('/api/invoices',     require('./routes/invoices'));
app.use('/api/quotes',       require('./routes/quotes'));
app.use('/api/horkram',      require('./routes/horkram'));
app.use('/api/purchasing',   require('./routes/purchasing'));
app.use('/api/orders',       require('./routes/orders'));
app.use('/api/receiving',    require('./routes/receiving'));
app.use('/api/attachments',      require('./routes/attachments'));
app.use('/api/staff',            require('./routes/staff'));
app.use('/api/goods-receipts',   require('./routes/goods-receipts'));
app.use('/api/schedule',         require('./routes/schedule'));
app.use('/api/help-content',     require('./routes/help'));
app.use('/api/sidekick',         require('./routes/sidekick'));

// Statisk serving af receipt-fotos (for Whiteboard link-only access)
app.use('/uploads/receipts', express.static(path.join(__dirname, 'data', 'uploads', 'receipts')));

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
