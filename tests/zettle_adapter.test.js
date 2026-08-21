// tests/zettle_adapter.test.js
// Unit-tests for services/zettleAdapter.js — Fase 1 (#508).
// Mocker fetch; intet netværk, ingen database, ingen Zettle-konto nødvendig.
//
//   node --test tests/zettle_adapter.test.js      ·      npm run test:zettle
//
// Fixtures: tests/fixtures/zettle/
//   purchases_festival.json  — REDIGERET uddrag af ægte svar (14. aug 2026)
//   purchases_synthetic.json — KONSTRUERET: refundering, kontant, løssalg,
//                              efter-midnat, EXCLUSIVE moms. Formerne findes
//                              ikke i kontoens 12 måneders historik (§15).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
    createZettleAdapter, ZettleError,
    normalizePurchase, findExclusiveVat,
    decodeJwtPayload, scopesFromToken, addDays, oereToKr,
} = require('../services/zettleAdapter');

const FIX = p => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/zettle', p), 'utf8'));
const REAL = FIX('purchases_festival.json').purchases;
const SYN  = FIX('purchases_synthetic.json').purchases;

/* ── Testhjælpere ─────────────────────────────────────────── */

const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const makeJwt = payload => `${b64u({ typ: 'JWT', alg: 'RS256' })}.${b64u(payload)}.sig`;
const TOKEN = makeJwt({ scope: 'READ:PURCHASE READ:FINANCE READ:PRODUCT', aud: 'API', iss: 'iZettle' });

function resp(status, body, { text = false } = {}) {
    const s = typeof body === 'string' ? body : JSON.stringify(body);
    return { status, ok: status >= 200 && status < 300, text: async () => s, json: async () => JSON.parse(s) };
}

/** Stateful fetch-mock. handler(url, init, i) → resp(). Optager alle kald. */
function mockFetch(handler) {
    const calls = [];
    const fn = async (url, init = {}) => { const i = calls.length; calls.push({ url: String(url), init }); return handler(String(url), init, i); };
    fn.calls = calls;
    return fn;
}

/** Standard-mock: token + én side køb. */
function okFetch(purchases = REAL, { expiresIn = 7200 } = {}) {
    return mockFetch((url) => {
        if (url.includes('oauth.zettle.com')) return resp(200, { access_token: TOKEN, expires_in: expiresIn });
        if (url.includes('/purchases/v2')) return resp(200, { purchases, lastPurchaseHash: null });
        return resp(404, { error: 'ukendt sti: ' + url });
    });
}

const mk = (fetchImpl, extra = {}) =>
    createZettleAdapter({ clientId: 'org-uuid', apiKey: 'nøgle', fetchImpl, ...extra });

/* ══════════════════════════════════════════════════════════
   RENE HJÆLPERE
   ══════════════════════════════════════════════════════════ */

test('oereToKr: øre → kroner, ét sted', () => {
    assert.equal(oereToKr(6500), 65);
    assert.equal(oereToKr(5321.25), 53.21);   // afrundes i øre først
    assert.equal(oereToKr(null), 0);
    assert.equal(oereToKr('12000'), 120);
});

test('addDays: ren datoaritmetik, også over måneds- og årsskifte', () => {
    assert.equal(addDays('2026-08-14', 1), '2026-08-15');
    assert.equal(addDays('2026-08-31', 1), '2026-09-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-29', 1), '2026-03-30');   // sommertidsskifte: dato-only, uberørt
    assert.throws(() => addDays('14-08-2026', 1), /YYYY-MM-DD/);
});

test('scopes læses af JWT-payloaden — token-svaret har dem ikke', () => {
    assert.deepEqual(scopesFromToken(TOKEN), ['READ:PURCHASE', 'READ:FINANCE', 'READ:PRODUCT']);
    assert.deepEqual(scopesFromToken('ikke-et-jwt'), []);
    assert.equal(decodeJwtPayload('ikke-et-jwt'), null);
});

/* ══════════════════════════════════════════════════════════
   NORMALISERING — mod ægte payloads
   ══════════════════════════════════════════════════════════ */

test('normalizePurchase: ægte køb → kroner incl moms, felterne på plads', () => {
    const p = normalizePurchase(REAL[0]);
    assert.equal(p.source, 'zettle');
    assert.equal(p.amount_incl, 65);
    assert.equal(p.vat_amount, 13);
    assert.equal(p.currency, 'DKK');
    assert.equal(p.taxation_mode, 'INCLUSIVE');
    assert.equal(p.payment_type, 'IZETTLE_CARD');
    assert.equal(p.is_refund, false);
    assert.ok(p.purchase_uuid, 'purchase_uuid skal med — det er idempotens-nøglen');
    assert.ok(p.site_uuid, 'site_uuid skal med — det bliver events.pos_store_ref');
    assert.equal(p.lines.length, 1);
    assert.equal(p.lines[0].name, 'Slider Frikadelle');
    assert.equal(p.lines[0].quantity, 1);
    assert.equal(p.lines[0].unit_price_incl, 65);
    assert.equal(p.lines[0].line_total_incl, 65);
});

test('normalizePurchase: moms omregnes ALDRIG — prisen bæres råt igennem', () => {
    // Grundlaget for hele designet: Zettle-priser er incl moms og matcher
    // bon_lines.unit_price direkte (§6b). En omregning her ville være en fejl.
    for (const raw of REAL) {
        const p = normalizePurchase(raw);
        for (const l of p.lines) {
            assert.equal(l.unit_price_incl, oereToKr(raw.products.find(x => x.name === l.name).unitPrice));
        }
        // Summen af linjer skal ramme købets beløb (ingen skjult skalering).
        const sum = Math.round(p.lines.reduce((s, l) => s + l.line_total_incl, 0) * 100) / 100;
        assert.equal(sum, p.amount_incl, `linjesum ≠ købsbeløb for ${p.purchase_uuid}`);
    }
});

test('normalizePurchase: momsen er 25 % af nettoen på hvert ægte køb', () => {
    for (const raw of REAL) {
        const p = normalizePurchase(raw);
        const netto = Math.round((p.amount_incl - p.vat_amount) * 100) / 100;
        assert.equal(Math.round(netto * 0.25 * 100) / 100, p.vat_amount,
            `moms stemmer ikke for ${p.purchase_uuid}`);
    }
});

test('normalizePurchase: flerlinje-køb og antal > 1 bæres korrekt', () => {
    const multi = REAL.map(normalizePurchase).find(p => p.lines.length >= 3);
    assert.ok(multi, 'fixturen skal indeholde et flerlinje-køb');
    assert.equal(Math.round(multi.lines.reduce((s, l) => s + l.line_total_incl, 0) * 100) / 100, multi.amount_incl);

    const qty = REAL.map(normalizePurchase).find(p => p.lines.some(l => l.quantity > 1));
    assert.ok(qty, 'fixturen skal indeholde et køb med antal > 1');
    const l = qty.lines.find(x => x.quantity > 1);
    assert.equal(l.line_total_incl, Math.round(l.quantity * l.unit_price_incl * 100) / 100);
});

/* ══════════════════════════════════════════════════════════
   REFUNDERINGER — uverificeret format, defensiv håndtering
   ══════════════════════════════════════════════════════════ */

test('refundering med negativt beløb → negativ', () => {
    const p = normalizePurchase(SYN[0]);
    assert.equal(p.is_refund, true);
    assert.equal(p.amount_incl, -65);
    assert.equal(p.vat_amount, -13);
    assert.equal(p.lines[0].quantity, -1);
    assert.equal(p.lines[0].line_total_incl, -65);
    assert.equal(p.lines[0].unit_price_incl, 65, 'enhedsprisen forbliver positiv — det er antallet der vender');
    assert.equal(p.payments[0].amount_incl, -65);
    assert.equal(p.refunds_purchase_uuid, 'cf96f2e1-0d5d-3be5-e0de-c0c2bc1b8ab6');
});

test('refundering med POSITIVT beløb + flag → også negativ', () => {
    // Formatet er uverificeret (0 refunderinger i 12 mdr). Kommer den som et
    // positivt beløb med refund-flag, må den ikke lægges TIL omsætningen.
    const p = normalizePurchase(SYN[1]);
    assert.equal(p.is_refund, true);
    assert.equal(p.amount_incl, -65);
    assert.equal(p.lines[0].quantity, -1);
    assert.equal(p.payments[0].amount_incl, -65);
});

test('to modsatte former for samme refundering giver samme resultat', () => {
    const a = normalizePurchase(SYN[0]), b = normalizePurchase(SYN[1]);
    assert.equal(a.amount_incl, b.amount_incl);
    assert.equal(a.lines[0].quantity, b.lines[0].quantity);
});

/* ══════════════════════════════════════════════════════════
   ØVRIGE FORMER
   ══════════════════════════════════════════════════════════ */

test('løssalg uden produktkort er en gyldig linje, ikke en fejl', () => {
    // Beslutning nr. 2: der sælges også andet end det der ligger i Grocy.
    const p = normalizePurchase(SYN[2]);
    assert.equal(p.custom_amount_sale, true);
    assert.equal(p.lines[0].product_uuid, null);
    assert.equal(p.lines[0].name, 'Løssalg');
    assert.equal(p.amount_incl, 50);
    assert.equal(p.payment_type, 'CASH');
});

test('variantnavn og efter-midnat-tidsstempel bevares', () => {
    const p = normalizePurchase(SYN[3]);
    assert.equal(p.lines[0].variant_name, 'Glutenfri');
    assert.equal(p.lines[0].quantity, 2);
    assert.equal(p.lines[0].line_total_incl, 120);
    assert.equal(p.occurred_at, '2026-08-16T00:30:00.000+0000',
        'tidsstemplet bæres råt — døgnskiftet afgøres i Fase 2, ikke i adapteren');
});

test('findExclusiveVat fanger et køb hvor momsen IKKE er i prisen', () => {
    // Hele designet hviler på INCLUSIVE. Skiftede det, ville bonnen få for
    // lave priser uden at tallet så forkert ud.
    const all = SYN.map(normalizePurchase);
    const bad = findExclusiveVat(all);
    assert.equal(bad.length, 1);
    assert.equal(bad[0].taxation_mode, 'EXCLUSIVE');
    assert.equal(findExclusiveVat(REAL.map(normalizePurchase)).length, 0, 'ægte data skal være rene');
});

test('normalizePurchase afviser tomt input frem for at opfinde et køb', () => {
    assert.throws(() => normalizePurchase(null), ZettleError);
    assert.throws(() => normalizePurchase('nope'), ZettleError);
});

/* ══════════════════════════════════════════════════════════
   AUTH
   ══════════════════════════════════════════════════════════ */

test('token hentes med JWT-bearer-grant og API-nøglen som assertion', async () => {
    const f = okFetch();
    const t = await mk(f).getAccessToken();
    assert.equal(t, TOKEN);
    const call = f.calls[0];
    assert.match(call.url, /oauth\.zettle\.com/);
    assert.equal(call.init.method, 'POST');
    const body = new URLSearchParams(call.init.body);
    assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.equal(body.get('client_id'), 'org-uuid');
    assert.equal(body.get('assertion'), 'nøgle');
});

test('token caches — og genhentes når det udløber', async () => {
    let clock = 0;
    const f = okFetch();
    const a = createZettleAdapter({ clientId: 'x', apiKey: 'y', fetchImpl: f, now: () => clock });
    await a.getAccessToken();
    await a.getAccessToken();
    assert.equal(f.calls.length, 1, 'andet kald skal komme fra cachen');
    clock = 7200 * 1000;                       // efter udløb (60 s margin)
    await a.getAccessToken();
    assert.equal(f.calls.length, 2);
});

test('clearCache tvinger nyt token', async () => {
    const f = okFetch();
    const a = mk(f);
    await a.getAccessToken();
    a.clearCache();
    await a.getAccessToken();
    assert.equal(f.calls.length, 2);
});

test('manglende credentials giver not_configured — ikke et netværkskald', async () => {
    const f = okFetch();
    const a = createZettleAdapter({ fetchImpl: f });
    assert.equal(a.isConfigured(), false);
    await assert.rejects(() => a.getAccessToken(), e => e.code === 'not_configured');
    assert.equal(f.calls.length, 0);
});

test('afvist nøgle giver auth_failed med status', async () => {
    const f = mockFetch(() => resp(401, 'Unauthorized'));
    await assert.rejects(() => mk(f).getAccessToken(), e => e.code === 'auth_failed' && e.status === 401);
});

test('timeout mærkes som timeout, ikke som en ukendt fejl', async () => {
    const f = mockFetch(async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; });
    await assert.rejects(() => mk(f).getAccessToken(), e => e.code === 'timeout');
});

/* ══════════════════════════════════════════════════════════
   HENT KØB
   ══════════════════════════════════════════════════════════ */

test('getPurchases sender EKSKLUSIV endDate for et inklusivt interval', async () => {
    // Målt kvirk: startDate=endDate giver 0 køb. Kaldere skal ikke kende den.
    const f = okFetch();
    await mk(f).getPurchases({ from: '2026-08-14', to: '2026-08-14' });
    const u = new URL(f.calls[1].url);
    assert.equal(u.searchParams.get('startDate'), '2026-08-14');
    assert.equal(u.searchParams.get('endDate'), '2026-08-15');
});

test('getPurchases returnerer normaliserede køb (og rå på forlangende)', async () => {
    const a = mk(okFetch());
    const norm = await a.getPurchases({ from: '2026-08-14', to: '2026-08-14' });
    assert.equal(norm.length, REAL.length);
    assert.equal(norm[0].amount_incl, 65);
    a.clearCache();
    const raw = await mk(okFetch()).getPurchases({ from: '2026-08-14', to: '2026-08-14', raw: true });
    assert.equal(raw[0].amount, 6500, 'rå svar skal være urørt (øre)');
});

test('getPurchases pagineres via lastPurchaseHash', async () => {
    const f = mockFetch((url, init, i) => {
        if (url.includes('oauth')) return resp(200, { access_token: TOKEN, expires_in: 7200 });
        if (i === 1) return resp(200, { purchases: REAL.slice(0, 2), lastPurchaseHash: 'h1' });
        if (i === 2) return resp(200, { purchases: REAL.slice(2), lastPurchaseHash: 'h2' });
        return resp(200, { purchases: [] });
    });
    const out = await mk(f).getPurchases({ from: '2026-08-14', to: '2026-08-14' });
    assert.equal(out.length, REAL.length);
    assert.equal(new URL(f.calls[2].url).searchParams.get('lastPurchaseHash'), 'h1');
});

test('en paginering der gentager sig selv looper ikke — og dobbelttæller ikke', async () => {
    // Uden værn ville samme side blive hentet maxPages gange og hvert køb
    // talt lige så mange gange. Det ville se ud som en meget god dag.
    const f = mockFetch((url) => {
        if (url.includes('oauth')) return resp(200, { access_token: TOKEN, expires_in: 7200 });
        return resp(200, { purchases: REAL, lastPurchaseHash: 'altid-den-samme' });
    });
    const out = await mk(f, { maxPages: 10 }).getPurchases({ from: '2026-08-14', to: '2026-08-14' });
    assert.equal(out.length, REAL.length);
    assert.ok(f.calls.length <= 4, `for mange kald: ${f.calls.length}`);
});

test('getPurchases validerer datoer frem for at spørge på noget vilkårligt', async () => {
    const a = mk(okFetch());
    await assert.rejects(() => a.getPurchases({ from: '14-08-2026', to: '2026-08-14' }), e => e.code === 'bad_input');
    await assert.rejects(() => a.getPurchases({ from: '2026-08-14' }), e => e.code === 'bad_input');
    await assert.rejects(() => a.getPurchases({ from: '2026-08-20', to: '2026-08-14' }), e => e.code === 'bad_input');
});

test('HTTP-fejl på køb bobler op med status', async () => {
    const f = mockFetch((url) => url.includes('oauth')
        ? resp(200, { access_token: TOKEN, expires_in: 7200 })
        : resp(503, 'Service Unavailable'));
    await assert.rejects(() => mk(f).getPurchases({ from: '2026-08-14', to: '2026-08-14' }),
        e => e.code === 'http_error' && e.status === 503);
});

/* ══════════════════════════════════════════════════════════
   HEALTHCHECK — Settings-panelet (§12)
   ══════════════════════════════════════════════════════════ */

test('healthCheck melder ok med de nødvendige scopes', async () => {
    const h = await mk(okFetch()).healthCheck();
    assert.equal(h.ok, true);
    assert.equal(h.configured, true);
    assert.deepEqual(h.missing_scopes, []);
});

test('healthCheck navngiver et manglende scope i stedet for at fejle senere', async () => {
    const thin = makeJwt({ scope: 'READ:PRODUCT' });
    const f = mockFetch((url) => url.includes('oauth')
        ? resp(200, { access_token: thin, expires_in: 7200 }) : resp(404, {}));
    const h = await mk(f).healthCheck();
    assert.equal(h.ok, false);
    assert.deepEqual(h.missing_scopes, ['READ:PURCHASE', 'READ:FINANCE']);
    assert.match(h.reason, /READ:PURCHASE/);
});

test('healthCheck kaster ikke når nøglen mangler — panelet skal kunne vise det', async () => {
    const h = await createZettleAdapter({ fetchImpl: okFetch() }).healthCheck();
    assert.equal(h.ok, false);
    assert.equal(h.configured, false);
    assert.match(h.reason, /ZETTLE_CLIENT_ID/);
});
