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

/* ──────────────────────────────────────────────────────────────
   STREAMENS LEVETID

   Hele domænet kører HTTP/2, så alle sider deler ÉN TCP-forbindelse til
   serveren. En SSE-stream der står åben i timevis holder netop den forbindelse
   fastlåst — også når den er blevet ubrugelig (dvale, Wi-Fi-skift). Næste
   navigation genbruger den døde forbindelse og fejler med "Der er ingen
   internetforbindelse" (#423).

   Ved at lukke streamen med jævne mellemrum cykler forbindelsen i stedet.
   Klienten genopretter selv (det er indbygget i EventSource), og replay via
   Last-Event-ID nedenfor sikrer at intet går tabt i mellemtiden.

   Jitteren spreder genopkoblingerne, så alle skærme ikke rammer serveren i
   samme sekund.
   ────────────────────────────────────────────────────────────── */
const STREAM_MAX_MS    = Number(process.env.SSE_STREAM_MAX_MS    || 10 * 60 * 1000);
const STREAM_JITTER_MS = Number(process.env.SSE_STREAM_JITTER_MS ||  2 * 60 * 1000);
const CLIENT_RETRY_MS  = Number(process.env.SSE_CLIENT_RETRY_MS  ||           3000);

/* ──────────────────────────────────────────────────────────────
   REPLAY

   Uden dette taber en genopkobling — planlagt som uplanlagt — de events der
   faldt mens forbindelsen var nede. Buffer + `Last-Event-ID` lukker hullet.

   To ting der IKKE må skride:
   - `sendTo`-events er adresserede. De må kun afspilles til deres egen bruger.
   - Et `broadcast` med `excludeUserId` sprang afsenderen over. Det skal det
     blive ved med at gøre ved replay, ellers ser afsenderen sit eget ekko.

   Id'et bærer et epoke-mærke, så et `Last-Event-ID` fra FØR en genstart ikke
   tolkes som en position i den nye tællers rækkefølge.
   ────────────────────────────────────────────────────────────── */
const REPLAY_MAX = Number(process.env.SSE_REPLAY_MAX || 200);
const EPOCH      = Date.now().toString(36);

const replayBuffer = [];   // [{ id, payload, userId, excludeUserId }]
let seq = 0;

function frame(id, eventName, data) {
    return `id: ${EPOCH}-${id}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

function record(id, payload, userId, excludeUserId) {
    replayBuffer.push({ id, payload, userId, excludeUserId });
    if (replayBuffer.length > REPLAY_MAX) replayBuffer.shift();
}

function parseLastId(raw) {
    if (!raw) return 0;
    const s = String(raw);
    const dash = s.lastIndexOf('-');
    if (dash < 0) return 0;
    if (s.slice(0, dash) !== EPOCH) return 0;   // anden proces — replay ville være vrøvl
    const n = Number(s.slice(dash + 1));
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function replayFor(res, userId, sinceId) {
    let sent = 0;
    for (const ev of replayBuffer) {
        if (ev.id <= sinceId) continue;
        if (ev.userId !== null && ev.userId !== userId) continue;          // adresseret til en anden
        if (ev.excludeUserId !== null && ev.excludeUserId === userId) continue;  // eget ekko
        if (!write(res, ev.payload)) break;
        sent++;
    }
    return sent;
}

/** Skriv til en stream der kan være lukket i mellemtiden. */
function write(res, payload) {
    if (res.writableEnded || res.destroyed) return false;
    try {
        res.write(payload);
        return true;
    } catch (err) {
        return false;
    }
}

// GET /api/sse
router.get('/', (req, res) => {
    const userId = String(req.query.client_id || req.query.user_id || 'anon');

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Tilføj til begge strukturer
    allClients.add(res);
    if (!clients.has(userId)) clients.set(userId, new Set());
    clients.get(userId).add(res);

    // Heartbeat hvert 25. sekund
    const hb = setInterval(() => write(res, ':heartbeat\n\n'), 25000);

    // Luk streamen efter et stykke tid, så HTTP/2-forbindelsen cykler.
    const lifespan = setTimeout(() => {
        write(res, ':cycling\n\n');
        try { res.end(); } catch (err) { /* stille */ }
    }, STREAM_MAX_MS + Math.floor(Math.random() * STREAM_JITTER_MS));

    let cleanedUp = false;
    function cleanup() {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(hb);
        clearTimeout(lifespan);
        allClients.delete(res);
        const bucket = clients.get(userId);
        if (bucket) {
            bucket.delete(res);
            if (bucket.size === 0) clients.delete(userId);
        }
        console.log(`SSE: bruger ${userId} frakoblet (${allClients.size} aktive)`);
    }

    // Både når klienten går, og når vi selv lukker streamen.
    req.on('close', cleanup);
    res.on('close', cleanup);

    write(res, `retry: ${CLIENT_RETRY_MS}\n\n`);
    write(res, `event: connected\ndata: ${JSON.stringify({ userId })}\n\n`);

    const sinceId = parseLastId(req.headers['last-event-id'] || req.query.last_event_id);
    const replayed = sinceId ? replayFor(res, userId, sinceId) : 0;

    console.log(`SSE: bruger ${userId} tilsluttet (${allClients.size} aktive` +
        (replayed ? `, ${replayed} genafspillet` : '') + ')');
});

// Send til alle — undtagen evt. afsender
function broadcast(eventName, data, excludeUserId = null) {
    const id = ++seq;
    const exclude = excludeUserId == null ? null : String(excludeUserId);
    const payload = frame(id, eventName, data);
    record(id, payload, null, exclude);

    if (exclude === null) {
        for (const res of allClients) write(res, payload);
    } else {
        const excludeSet = clients.get(exclude);
        for (const res of allClients) {
            if (excludeSet && excludeSet.has(res)) continue;
            write(res, payload);
        }
    }
}

// Send til alle forbindelser for én specifik bruger
function sendTo(userId, eventName, data) {
    const uid = String(userId);
    const id = ++seq;
    const payload = frame(id, eventName, data);
    // Bufferes også når brugeren ikke er online lige nu — så får de den ved
    // genopkobling i stedet for at den forsvinder.
    record(id, payload, uid, null);

    const bucket = clients.get(uid);
    if (!bucket) return;
    for (const res of bucket) write(res, payload);
}

function clientCount() { return allClients.size; }

module.exports        = router;
module.exports.broadcast   = broadcast;
module.exports.sendTo      = sendTo;
module.exports.clientCount = clientCount;
