// server.js
// ==========================================
// Bon v2 — Indgangspunkt
// ==========================================

try { require('dotenv').config(); } catch {} // npm install dotenv hvis mangler
const express   = require('express');
const path      = require('path');
const { getDb } = require('./db/database');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────
app.use(express.json());

// Statiske filer: HTML, CSS, klient-JS
// serveres direkte fra rod-mappen
app.use(express.static(path.join(__dirname)));

// ── Database (migrations køres ved opstart) ─
const db = getDb();
console.log('✓ Database klar');

// ── API-routes ────────────────────────────

// SSE — live opdateringer til alle klienter
app.use('/api/events',  require('./shared/sse'));

// Kitchen-zone API
app.use('/api/kitchen', require('./kitchen/api'));

// TODO — tilføjes efterhånden:
// app.use('/api/bons',  require('./office/views/bons-list'));
// app.use('/api/crm',   require('./office/views/crm'));
// app.use('/api/auth',  require('./office/views/auth'));

// ── Start ─────────────────────────────────
app.listen(PORT, () => {
    console.log(`\nBon v2 kører → http://localhost:${PORT}`);
    console.log(`Kitchen I Dag → http://localhost:${PORT}/kitchen/today.html\n`);
});

module.exports = { app, db };
