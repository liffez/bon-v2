/**
 * tests/scripts/helpers/login.js
 * ════════════════════════════════════════════════════════════
 * Session-login til track-runnere.
 *
 * Siden #316 (global auth-gate på /api, deny-by-default) skal enhver
 * klient — også en test-runner — have en session. Uden svarer alt 401,
 * og runneren dør ved første kald med "Server svarer 401 på …".
 *
 * Auth er ROLLE-baseret (delt PIN-konto), ikke per person: PIN 1234 er
 * køkken-rollen i test.db's seed. Runnere skal derfor bruge PIN-login,
 * ikke email+password.
 *
 * Login-koden lå ordret i 19 runnere før dette modul. Næste ændring i
 * auth-flowet ville have været et 19-fils-indgreb; nu er den ét sted.
 * Eksisterende runnere er ikke konverteret — de virker — men nye bør
 * bruge denne, og gamle kan flyttes over når man alligevel er inde i dem.
 *
 * Usage:
 *   const { login, withSession } = require('./helpers/login');
 *
 *   // 1) Enkel: hent cookien og send den selv med
 *   const cookie = await login(SERVER_URL);
 *   fetch(url, { headers: { Cookie: cookie } });
 *
 *   // 2) Nemmest: pak en api()-agtig funktion så cookien altid følger med
 *   const api = withSession(SERVER_URL, cookie);
 *   const res = await api('GET', '/api/grocy/stock');
 *   //   → { status, body, raw }
 *
 * Reference: #335 · tests/specs/T_*.md
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const DEFAULT_PIN = process.env.TEST_PIN || '1234';

/**
 * Log ind som rolle og returnér session-cookien.
 *
 * @param {string} serverUrl  fx http://localhost:4322
 * @param {string} [pin]      default TEST_PIN eller '1234'
 * @returns {Promise<string>} cookie-strengen til Cookie-headeren
 */
async function login(serverUrl, pin = DEFAULT_PIN) {
    let res;
    try {
        res = await fetch(`${serverUrl}/api/auth/pin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin }),
        });
    } catch (err) {
        throw new Error(
            `Kunne ikke nå ${serverUrl} — kører test:server? (${err.message})`
        );
    }

    if (res.status !== 200) {
        throw new Error(
            `Login fejlede: ${res.status}. Findes en aktiv bruger med PIN ${pin} i test.db? ` +
            `(npm run test:reset seeder den)`
        );
    }

    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    if (!cookie) {
        throw new Error(
            'Ingen set-cookie modtaget. Er SESSION_SECRET sat, og er cookie.secure ' +
            'slået fra på localhost?'
        );
    }
    return cookie;
}

/**
 * Byg en api()-funktion med samme form som track-runnernes egen:
 * api(method, path, body?) → { status, body, raw }
 *
 * Cookien sendes altid med. Ikke-JSON-svar giver body = null (raw bevares),
 * så en runner kan skelne "tomt svar" fra "ugyldig JSON".
 */
function withSession(serverUrl, cookie) {
    return async function api(method, pathPart, body = null) {
        const opts = { method, headers: {} };
        if (cookie) opts.headers['Cookie'] = cookie;
        if (body !== null && body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const res = await fetch(`${serverUrl}${pathPart}`, opts);
        const text = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* ikke-JSON er lovligt */ }
        return { status: res.status, body: parsed, raw: text };
    };
}

module.exports = { login, withSession, DEFAULT_PIN };
