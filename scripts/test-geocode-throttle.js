// scripts/test-geocode-throttle.js
// ==========================================
// Unit-tests for DAWA throttle-håndtering (User-Agent + retry-med-backoff).
// Mocker global.fetch — rammer aldrig et rigtigt API.
//
//   node scripts/test-geocode-throttle.js
// ==========================================

const { geocodeRaw, DawaError } = require('../services/geocode');

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  ✓', msg); pass++; }
    else      { console.error('  ✗', msg); fail++; }
}

const realFetch = global.fetch;
// Retry-After: '0' → backoff venter 0 ms, så testen er hurtig.
function res(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '0' : null) },
        json: async () => body,
    };
}
function mockFetch(queue) {
    const calls = [];
    global.fetch = async (url, opts) => {
        calls.push({ url, ua: opts?.headers?.['User-Agent'] });
        const next = queue.shift();
        if (typeof next === 'function') return next();
        return next;
    };
    return calls;
}

(async () => {
    const HIT = [{ x: 12.5523, y: 55.6934 }];

    // 1) To 429'ere efterfulgt af et hit → retry lykkes
    console.log('\nretry på 429');
    {
        const calls = mockFetch([res(429), res(429), res(200, HIT)]);
        const coords = await geocodeRaw({ street: 'Testvej', nr: '1', zip: '2200' });
        assert(coords && coords.lat === 55.6934, 'geokoder efter to 429-retries');
        assert(calls.length === 3, 'kaldte fetch 3 gange (2 retries + 1 succes)');
        assert(calls.every(c => c.ua && c.ua.includes('bon-v2')), 'sender User-Agent på hvert kald');
    }

    // 2) Vedvarende 429 → kaster DawaError(throttled)
    console.log('\nvedvarende throttle');
    {
        mockFetch(Array.from({ length: 20 }, () => res(429)));
        let threw = null;
        try { await geocodeRaw({ street: 'Testvej', nr: '1', zip: '2200' }); }
        catch (e) { threw = e; }
        assert(threw instanceof DawaError, 'kaster DawaError ved vedvarende throttle');
        assert(threw && threw.throttled === true, 'fejlen er markeret throttled');
    }

    // 3) 200 men ingen match (tom liste) → null, ingen exception, falder gennem fallbacks
    console.log('\ningen match');
    {
        mockFetch([res(200, []), res(200, []), res(200, { resultater: [] })]);
        const coords = await geocodeRaw({ street: 'Ukendtvej', nr: '999', zip: '9999' });
        assert(coords === null, 'returnerer null ved no-match (ingen throw)');
    }

    // 4) Permanent HTTP-fejl (400) → ikke throttle, falder gennem til null
    console.log('\npermanent HTTP-fejl');
    {
        mockFetch([res(400), res(400), res(400)]);
        const coords = await geocodeRaw({ street: 'Fejlvej', nr: '1', zip: '2200' });
        assert(coords === null, '400 behandles som no-match (falder gennem fallbacks → null)');
    }

    global.fetch = realFetch;
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})();
