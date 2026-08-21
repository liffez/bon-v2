// tests/sse_stream.test.js
// ==========================================================================
// SSE: streamen cykler af sig selv, og en genopkobling taber ikke events.
//
// Baggrund (#423): en stream der står åben i timevis holder domænets ene
// HTTP/2-forbindelse fastlåst, så næste navigation fejler med "Der er ingen
// internetforbindelse". Streamen lukkes derfor med jævne mellemrum — men det
// må ikke koste events, og replay må ikke lække adresserede events til andre.
//
// Kør: node --test tests/sse_stream.test.js
// ==========================================================================

// SKAL sættes før modulet loades — konstanterne læses ved require.
process.env.SSE_STREAM_MAX_MS    = '400';
process.env.SSE_STREAM_JITTER_MS = '0';
process.env.SSE_CLIENT_RETRY_MS  = '1500';

const test   = require('node:test');
const assert = require('node:assert');
const http   = require('node:http');
const express = require('express');

const sse = require('../shared/sse');

let server, port;

test.before(async () => {
    const app = express();
    app.use('/api/sse', sse);
    server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
});

test.after(() => new Promise(r => {
    // Aabne streams holder ellers serveren i live, og close() kalder aldrig tilbage.
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(r);
}));

/** Åbn en SSE-stream og saml alle rammer som rå tekst. */
function open(clientId, lastEventId) {
    const headers = { Accept: 'text/event-stream' };
    if (lastEventId) headers['Last-Event-ID'] = lastEventId;

    const stream = {
        text: '',
        ended: false,
        status: null,
        req: null,
        ids: () => [...stream.text.matchAll(/^id: (\S+)$/gm)].map(m => m[1]),
        events: () => [...stream.text.matchAll(/^event: (\S+)$/gm)].map(m => m[1]),
        /** Vent til `pred(stream)` er sand — ellers fejl med det vi nåede at se. */
        waitFor(pred, label, ms = 3000) {
            const deadline = Date.now() + ms;
            return new Promise((resolve, reject) => {
                (function poll() {
                    if (pred(stream)) return resolve(stream);
                    if (Date.now() > deadline) {
                        return reject(new Error(
                            `timeout ventende på ${label}\n--- set ---\n${stream.text}`));
                    }
                    setTimeout(poll, 15);
                })();
            });
        },
        close() { stream.req.destroy(); }
    };

    return new Promise((resolve) => {
        stream.req = http.get(
            { host: '127.0.0.1', port, path: `/api/sse?client_id=${clientId}`, headers },
            (res) => {
                stream.status = res.statusCode;
                res.setEncoding('utf8');
                res.on('data', c => { stream.text += c; });
                res.on('end',  () => { stream.ended = true; });
                res.on('close',() => { stream.ended = true; });
                resolve(stream);
            }
        );
    });
}

const connected = s => s.events().includes('connected');

test('streamen åbner med retry-direktiv og et connected-event', async () => {
    const s = await open('t1');
    await s.waitFor(connected, 'connected');

    assert.equal(s.status, 200);
    assert.match(s.text, /^retry: 1500$/m, 'retry-direktivet skal sættes eksplicit');
    s.close();
});

test('events bærer et id, så klienten kan bede om replay', async () => {
    const s = await open('t2');
    await s.waitFor(connected, 'connected');

    sse.broadcast('bon_status', { id: 7, status: 'KLAR' });
    await s.waitFor(x => x.events().includes('bon_status'), 'bon_status');

    const ids = s.ids();
    assert.equal(ids.length, 1, 'præcis ét id-mærket event');
    assert.match(ids[0], /^[a-z0-9]+-1$/, 'id = <epoke>-<løbenummer>');
    s.close();
});

test('streamen lukker sig selv, og serveren rydder op efter den', async () => {
    const s = await open('t3');
    await s.waitFor(connected, 'connected');
    // Maalt EFTER aabningen: tidligere tests kan stadig vaere ved at rydde op,
    // saa en foer/efter-sammenligning ville vaere et kapsloeb.
    const withStream = sse.clientCount();
    assert.ok(withStream >= 1);

    // Ingen close() her — serveren skal selv afslutte den.
    await s.waitFor(x => x.ended, 'at streamen lukkes af serveren', 3000);

    // Oprydningen sker på close-eventet, altså en tick eller to senere.
    await new Promise(r => setTimeout(r, 150));
    assert.ok(sse.clientCount() < withStream, 'forbindelsen skal ud af registret igen');
});

test('genopkobling med Last-Event-ID afspiller kun det man gik glip af', async () => {
    const first = await open('t4');
    await first.waitFor(connected, 'connected');

    sse.broadcast('bon_status', { n: 1 });
    await first.waitFor(x => x.ids().length === 1, 'første event');
    const seenId = first.ids()[0];
    first.close();

    // Sker mens klienten er væk.
    sse.broadcast('bon_updated', { n: 2 });
    sse.broadcast('bon_created', { n: 3 });

    const again = await open('t4', seenId);
    await again.waitFor(x => x.events().includes('bon_created'), 'replay');

    const events = again.events();
    assert.ok(events.includes('bon_updated'), 'det missede event skal komme med');
    assert.ok(events.includes('bon_created'), 'også det næste');
    assert.ok(!events.includes('bon_status'), 'men ikke det man allerede havde set');
    again.close();
});

test('et adresseret event afspilles ikke til en anden bruger', async () => {
    const anker = await open('anker');
    await anker.waitFor(connected, 'connected');
    sse.broadcast('bon_status', { markør: true });
    await anker.waitFor(x => x.ids().length === 1, 'markør');
    const markørId = anker.ids()[0];
    anker.close();

    sse.sendTo('anne', 'notification', { hemmelig: 'flyver til Anne' });
    sse.broadcast('bon_updated', { alle: true });

    const bo = await open('bo', markørId);
    await bo.waitFor(x => x.events().includes('bon_updated'), 'replay af broadcast');

    assert.ok(!bo.text.includes('hemmelig'), 'Bo må ikke få Annes flyver ved replay');

    const anne = await open('anne', markørId);
    await anne.waitFor(x => x.text.includes('hemmelig'), 'Annes egen flyver');

    bo.close();
    anne.close();
});

test('afsenderen ser ikke sit eget ekko ved replay', async () => {
    const anker = await open('anker2');
    await anker.waitFor(connected, 'connected');
    sse.broadcast('bon_status', { markør: true });
    await anker.waitFor(x => x.ids().length === 1, 'markør');
    const markørId = anker.ids()[0];
    anker.close();

    // Afsenderen 'ida' udelukkes fra dette broadcast.
    sse.broadcast('bon_updated', { ekko: true }, 'ida');

    const ida = await open('ida', markørId);
    await ida.waitFor(connected, 'connected');
    await new Promise(r => setTimeout(r, 120));
    assert.ok(!ida.text.includes('ekko'), 'ekskluderingen skal også gælde replay');

    const anden = await open('anden', markørId);
    await anden.waitFor(x => x.text.includes('ekko'), 'alle andre får det');

    ida.close();
    anden.close();
});

test('et Last-Event-ID fra før en genstart udløser ikke replay', async () => {
    sse.broadcast('bon_status', { n: 99 });

    // Anden epoke = en anden proces. Positionen betyder intet her.
    const s = await open('t7', 'zzzzzzzz-1');
    await s.waitFor(connected, 'connected');
    await new Promise(r => setTimeout(r, 120));

    assert.deepEqual(s.events(), ['connected'], 'kun connected — intet genafspillet');
    s.close();
});
