// shared/sse.js
// ==========================================
// Server-Sent Events — live opdateringer
// til køkken-displays og flyvere.
//
// Klient-siden (kitchen/today.html) forbinder:
//   const es = new EventSource('/api/events?user_id=2');
//   es.addEventListener('bon_updated', e => { ... });
//   es.addEventListener('flyver', e => { ... });
// ==========================================

const express = require('express');
const router  = express.Router();

// Aktive SSE-forbindelser: userId (string) → res
const clients = new Map();

// GET /api/events
router.get('/', (req, res) => {
    const userId = String(req.query.user_id || 'anon');

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    clients.set(userId, res);

    // Heartbeat hvert 25. sekund
    const hb = setInterval(() => res.write(':heartbeat\n\n'), 25000);

    req.on('close', () => {
        clearInterval(hb);
        clients.delete(userId);
    });

    res.write(`data: ${JSON.stringify({ type: 'connected', userId })}\n\n`);
    console.log(`SSE: bruger ${userId} tilsluttet (${clients.size} aktive)`);
});

// Send til alle — undtagen evt. afsender
function broadcast(eventName, data, excludeUserId = null) {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [uid, res] of clients) {
        if (uid !== String(excludeUserId)) res.write(payload);
    }
}

// Send til én specifik bruger
function sendTo(userId, eventName, data) {
    const client = clients.get(String(userId));
    if (client) client.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

function clientCount() { return clients.size; }

module.exports        = router;
module.exports.broadcast   = broadcast;
module.exports.sendTo      = sendTo;
module.exports.clientCount = clientCount;
