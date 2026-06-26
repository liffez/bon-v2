// routes/delivery_views.js
// ==========================================
// HTML-views relateret til delivery — kun popout-vinduet til manuel
// bestilling pt. Mountet på app-root (ikke under /api) fordi den
// serverer en HTML-side, ikke JSON.
//
// Spec: docs/CLAUDE_DELIVERY_POPOUT.md
// ==========================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const NOTE_DIR = path.join(__dirname, '..', 'views', 'delivery');
const NOTE_HTML = path.join(NOTE_DIR, 'note.html');

// For HTML-popout: redirect til login frem for at returnere 401 JSON
// (requireAuth fra shared/auth.js er JSON-orienteret).
function requireAuthRedirect(req, res, next) {
    if (req.session && req.session.userId) return next();
    const next_url = encodeURIComponent(req.originalUrl);
    res.redirect(`/login.html?next=${next_url}`);
}

// Cache-bust: stempl asset-URL med filens ændringstidspunkt, så browseren
// henter ny note.js/note.css efter et deploy. Popout'et er et separat vindue
// der ofte genbruges (samme target-navn) — uden versionering kan det hænge
// fast i gammel cachet JS.
function assetVersion(file) {
    try {
        return String(Math.floor(fs.statSync(file).mtimeMs));
    } catch {
        return '0';
    }
}

// GET /delivery/note/:bon_id?vehicle=ID
// Læser note.html og injicerer versionerede asset-URL'er. Al logik er
// klient-side via /api/delivery/booking-payload.
router.get('/note/:bon_id', requireAuthRedirect, (req, res) => {
    let html;
    try {
        html = fs.readFileSync(NOTE_HTML, 'utf8');
    } catch {
        return res.status(500).send('Kunne ikke indlæse bestillingsvinduet');
    }

    const jsV = assetVersion(path.join(NOTE_DIR, 'note.js'));
    const cssV = assetVersion(path.join(NOTE_DIR, 'note.css'));
    html = html
        .replace('/views/delivery/note.js', `/views/delivery/note.js?v=${jsV}`)
        .replace('/views/delivery/note.css', `/views/delivery/note.css?v=${cssV}`);

    res.set('Cache-Control', 'no-cache');
    res.type('html').send(html);
});

module.exports = router;
