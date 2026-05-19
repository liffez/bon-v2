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
const router = express.Router();

// For HTML-popout: redirect til login frem for at returnere 401 JSON
// (requireAuth fra shared/auth.js er JSON-orienteret).
function requireAuthRedirect(req, res, next) {
    if (req.session && req.session.userId) return next();
    const next_url = encodeURIComponent(req.originalUrl);
    res.redirect(`/login.html?next=${next_url}`);
}

// GET /delivery/note/:bon_id?vehicle=ID
// Statisk HTML — al logik er klient-side via /api/delivery/booking-payload.
router.get('/note/:bon_id', requireAuthRedirect, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'views', 'delivery', 'note.html'));
});

module.exports = router;
