/**
 * tests/scripts/helpers/sse_listener.js
 * ════════════════════════════════════════════════════════════
 * SSE-test-helper til office-track-runnere.
 *
 * Tilslutter en EventSource-lignende parser til /api/sse og venter på
 * specifikke named events. Bruges af T_BONS_LIST + alle fremtidige
 * office-tracks der skal verificere realtid-broadcasts.
 *
 * Node 22's native `fetch` understøtter ikke SSE direkte (giver
 * ReadableStream der så skal parses manuelt) — derfor egen mini-parser.
 *
 * Usage:
 *   const sse = require('./helpers/sse_listener');
 *   const listener = await sse.connect(serverUrl, cookie);
 *   ...trigger POST/PATCH der broadcaster...
 *   const event = await listener.waitForEvent('bon_created', e => e.id === id, 2000);
 *   listener.disconnect();
 *
 * Reference: tests/specs/T_BONS_LIST.md §2.3
 * ════════════════════════════════════════════════════════════
 */

'use strict';

/**
 * Tilslut SSE-lytter til serveren. Returnerer et listener-objekt med
 * waitForEvent() og disconnect().
 */
async function connect(serverUrl, cookie = null, options = {}) {
    const headers = { 'Accept': 'text/event-stream' };
    if (cookie) headers['Cookie'] = cookie;

    const controller = new AbortController();
    const url = `${serverUrl}/api/sse?client_id=test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const res = await fetch(url, {
        headers,
        signal: controller.signal,
    });

    if (!res.ok) {
        throw new Error(`SSE-connect fejlede: status=${res.status}`);
    }
    if (!res.body) {
        throw new Error('SSE-response har ingen body');
    }

    // Buffer + waiters
    const events = [];  // [{ name, data, raw, at }]
    const waiters = []; // [{ name, predicate, resolve, reject, timeoutId }]
    let closed = false;

    // Mini SSE-parser
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let currentEvent = null;
    let currentData = '';

    function dispatchEvent(name, data) {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch {}
        const evt = { name, data: parsed, raw: data, at: Date.now() };
        events.push(evt);

        // Forsøg at matche ventende waiters
        for (let i = waiters.length - 1; i >= 0; i--) {
            const w = waiters[i];
            if (w.name === name) {
                let pred = true;
                try { pred = w.predicate ? w.predicate(parsed) : true; } catch { pred = false; }
                if (pred) {
                    clearTimeout(w.timeoutId);
                    waiters.splice(i, 1);
                    w.resolve(evt);
                }
            }
        }
    }

    function processBuffer() {
        let lineEnd;
        while ((lineEnd = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, lineEnd).replace(/\r$/, '');
            buf = buf.slice(lineEnd + 1);

            if (line === '') {
                // Event-grænse
                if (currentEvent && currentData !== '') {
                    dispatchEvent(currentEvent, currentData);
                }
                currentEvent = null;
                currentData = '';
            } else if (line.startsWith(':')) {
                // Comment / heartbeat — ignorer
            } else if (line.startsWith('event:')) {
                currentEvent = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
                const piece = line.slice(5).trim();
                currentData = currentData ? currentData + '\n' + piece : piece;
            }
        }
    }

    // Bagrundsløkke der læser fra reader
    (async () => {
        try {
            while (!closed) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                processBuffer();
            }
        } catch (err) {
            if (!closed && err.name !== 'AbortError') {
                console.warn('[sse_listener] read-loop fejl:', err.message);
            }
        }
    })();

    function waitForEvent(name, predicate = null, timeoutMs = 2000) {
        // Tjek om event allerede ligger i buffer (kom før waitForEvent blev kaldt)
        for (const evt of events) {
            if (evt.name === name) {
                try {
                    if (!predicate || predicate(evt.data)) return Promise.resolve(evt);
                } catch {}
            }
        }
        // Ellers vent
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                const idx = waiters.findIndex(w => w.timeoutId === timeoutId);
                if (idx >= 0) waiters.splice(idx, 1);
                reject(new Error(`Timeout (${timeoutMs}ms) ventede på SSE-event '${name}'`));
            }, timeoutMs);
            waiters.push({ name, predicate, resolve, reject, timeoutId });
        });
    }

    function getEvents(name = null) {
        return name ? events.filter(e => e.name === name) : events.slice();
    }

    function clearEvents() {
        events.length = 0;
    }

    function disconnect() {
        closed = true;
        try { controller.abort(); } catch {}
        try { reader.cancel().catch(() => {}); } catch {}
        // Cleanup ventende waiters
        for (const w of waiters) {
            clearTimeout(w.timeoutId);
            w.reject(new Error('SSE-listener afsluttet før event'));
        }
        waiters.length = 0;
    }

    return { waitForEvent, getEvents, clearEvents, disconnect };
}

module.exports = { connect };
