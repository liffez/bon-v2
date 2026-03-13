// shared/sse.js
// ==========================================
// Server-Sent Events — live opdateringer
// til køkken-displays og flyvere.
//
// Brug:
//   server.js:   app.use('/api/sse', require('./shared/sse'));
//   routes:      const { broadcast } = require('../shared/sse');
//                broadcast('bon_status', { bon_id: 1, old: 'IGANG', new: 'KLAR' });
//
// Klient-siden:
//   const es = new EventSource('/api/sse');
//   es.addEventListener('bon_status', e => { ... });
//   es.addEventListener('notification', e => { ... });
// ==========================================

const express = require('express');
const router  = express.Router();

// Alle forbindelser (til broadcast)
const allClients = new Set();
// Per-bruger (til sendTo)
const clients = new Map();  // userId → Set<res>

// GET /api/sse
router.get('/', (req, res) => {
    const userId = String(req.query.client_id || req.query.user_id || 'anon');

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    // Tilføj til begge strukturer
    allClients.add(res);
    if (!clients.has(userId)) clients.set(userId, new Set());
    clients.get(userId).add(res);

    // Heartbeat hvert 25. sekund
    const hb = setInterval(() => res.write(':heartbeat\n\n'), 25000);

    req.on('close', () => {
        clearInterval(hb);
        allClients.delete(res);
        const bucket = clients.get(userId);
        if (bucket) {
            bucket.delete(res);
            if (bucket.size === 0) clients.delete(userId);
        }
        console.log(`SSE: bruger ${userId} frakoblet (${allClients.size} aktive)`);
    });

    res.write(`event: connected\ndata: ${JSON.stringify({ userId })}\n\n`);
    console.log(`SSE: bruger ${userId} tilsluttet (${allClients.size} aktive)`);
});

// Send til alle — undtagen evt. afsender
function broadcast(eventName, data, excludeUserId = null) {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    if (excludeUserId == null) {
        for (const res of allClients) res.write(payload);
    } else {
        const excludeSet = clients.get(String(excludeUserId));
        for (const res of allClients) {
            if (excludeSet && excludeSet.has(res)) continue;
            res.write(payload);
        }
    }
}

// Send til alle forbindelser for én specifik bruger
function sendTo(userId, eventName, data) {
    const bucket = clients.get(String(userId));
    if (!bucket) return;
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of bucket) res.write(payload);
}

function clientCount() { return allClients.size; }

module.exports        = router;
module.exports.broadcast   = broadcast;
module.exports.sendTo      = sendTo;
module.exports.clientCount = clientCount;
