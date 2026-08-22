const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');
const { handle, offsetISO } = require('../db/helpers');

// Statusser hvor en flyver ikke længere har nogen at nå.
//
// LEVERET står med selv om `is_terminal = 0`: maden er ude af huset, og en
// besked til køkkenet om den er lige så forældet som på en faktureret bon.
// Flaget kan altså ikke stå alene her — listen skrives ud.
const DONE_STATUSES = ['LEVERET', 'FAKTURERET', 'BETALT', 'AFSLUTTET', 'AFLYST'];

const DEFAULT_GRACE_DAYS = 2;

function graceDays(db) {
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'flyver_grace_days'`).get();
    const n   = parseInt(row?.value, 10);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_GRACE_DAYS;
}

// GET /api/notifications/unread?client_id=xxx
router.get('/unread', handle((req, res) => {
    const db       = getDb();
    const clientId = req.query.client_id;
    if (!clientId) return res.status(400).json({ error: 'client_id er påkrævet' });

    // Nulpunkt (#521): en skærm arver ikke historik. Første gang et client_id
    // spørger, stemples det — derefter ses kun flyvere sendt siden da.
    db.prepare(`INSERT OR IGNORE INTO notification_clients (client_id) VALUES (?)`).run(clientId);
    const firstSeenAt = db.prepare(`
        SELECT first_seen_at FROM notification_clients WHERE client_id = ?
    `).get(clientId).first_seen_at;

    const placeholders = DONE_STATUSES.map(() => '?').join(',');

    // `>=` på created_at, ikke `>`: en flyver sendt i samme sekund som
    // skærmen registreres skal med, ikke tabes på et sekunds afrunding.
    const rows = db.prepare(`
        SELECT n.*, b.bon_number
        FROM notifications n
        JOIN bons b ON n.bon_id = b.id
        JOIN status_definitions s ON b.status_id = s.id
        WHERE n.type = 'flyver'
          AND n.created_at >= ?
          AND s.code NOT IN (${placeholders})
          AND b.delivery_date >= ?
          AND n.id NOT IN (
              SELECT notification_id FROM notification_reads WHERE client_id = ?
          )
        ORDER BY n.created_at DESC
    `).all(firstSeenAt, ...DONE_STATUSES, offsetISO(-graceDays(db)), clientId);

    res.json(rows);
}));

module.exports = router;
