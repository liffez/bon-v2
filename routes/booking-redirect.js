// routes/booking-redirect.js
// ==========================================
// Kort URL for booking-tokens: GET /b/:token
//
// Mountet på /b i server.js (ikke under /api/booking) så URL'er bliver så
// korte som muligt i mails: https://bon.ristetrug.dk/b/76efbc7fe8f3333e
//
// Adfærd:
//   - 302 redirect til den fulde tools-side med ?t=TOKEN, baseret på
//     token's flow-felt ('smagning' eller 'kontakt')
//   - Ukendt eller udløbet token → 410 Gone med en nem fallback
//
// Open-tracking (open_count + opened_at) sker i GET /api/booking/token/:token
// så vi ikke dobbelt-tæller når kunden lander på tools-siden via /b.
// ==========================================

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

router.get('/:token', (req, res) => {
    const token = String(req.params.token || '').trim();
    if (!/^[a-f0-9]{8,64}$/i.test(token)) {
        return res.status(400).send('Ugyldigt link');
    }

    const db = getDb();
    const row = db.prepare(
        'SELECT token, flow, expires_at FROM booking_tokens WHERE token = ?'
    ).get(token);

    if (!row) {
        return res.status(410).send(
`<!doctype html><html lang="da"><meta charset="utf-8"><title>Linket findes ikke</title>
<style>body{font:16px/1.5 system-ui;max-width:480px;margin:60px auto;padding:0 20px;color:#333}</style>
<h1>Linket virker ikke længere</h1>
<p>Det link du har klikket på findes ikke. Det kan være forkert kopieret eller udløbet.</p>
<p>Kontakt os på <a href="mailto:kontakt@ristetrug.dk">kontakt@ristetrug.dk</a> hvis du har brug for at booke et møde.</p>`
        );
    }

    // Check udløb
    const expRow = db.prepare("SELECT 1 AS ok WHERE datetime(?) > datetime('now')").get(row.expires_at);
    if (!expRow?.ok) {
        return res.status(410).send(
`<!doctype html><html lang="da"><meta charset="utf-8"><title>Linket er udløbet</title>
<style>body{font:16px/1.5 system-ui;max-width:480px;margin:60px auto;padding:0 20px;color:#333}</style>
<h1>Linket er udløbet</h1>
<p>Booking-linket er ikke længere gyldigt. Bed sælger om at sende dig et nyt — eller kontakt os på <a href="mailto:kontakt@ristetrug.dk">kontakt@ristetrug.dk</a>.</p>`
        );
    }

    // 302 redirect til den korrekte tools-side
    const flow = (row.flow === 'kontakt') ? 'kontakt' : 'smagning';
    const targetUrl = `/tools/booking-${flow}.html?t=${encodeURIComponent(token)}`;
    res.redirect(302, targetUrl);
});

module.exports = router;
