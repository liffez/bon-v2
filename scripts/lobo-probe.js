#!/usr/bin/env node
// scripts/lobo-probe.js
// Engangs-DISCOVERY-værktøj mod Byekspressen/Lobo sandbox.
//
// Formål: fang de RIGTIGE shapes (V2-V5 i CLAUDE_LEVERING_LOBO.md) FØR vi skriver
// adapter-kode. Gemmer rå svar som fixtures så adapteren kan unit-testes mod dem.
//
// Ingen secrets i denne fil. Credentials læses fra env:
//   LOBO_USER=... LOBO_PASS=... [LOBO_BASE=...] node scripts/lobo-probe.js
//
// Default base = sandbox. Skriver fixtures til /tmp/lobo-probe/.
// Alle kald her er READ-ONLY (discovery). En testordre (POST /orders) er en WRITE
// og køres KUN hvis LOBO_BOOK_TEST=1 sættes eksplicit — se nederst.

const fs = require('fs');
const path = require('path');

const USER = process.env.LOBO_USER;
const PASS = process.env.LOBO_PASS;
const BASE = (process.env.LOBO_BASE
  || 'https://byexpressen.groupnet.at/lobo/sandbox/api/v3/public/').replace(/\/?$/, '/');
const OUT = '/tmp/lobo-probe';

if (!USER || !PASS) {
  console.error('Mangler LOBO_USER / LOBO_PASS i env.');
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });

function save(name, obj) {
  const file = path.join(OUT, name + '.json');
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}

// Hent en URL, gem status + udvalgte headers + body (json hvis muligt, ellers tekst).
async function probe(name, url, opts = {}) {
  const started = Date.now();
  let entry = { name, url, method: opts.method || 'GET' };
  try {
    const res = await fetch(url, opts);
    const ct = res.headers.get('content-type') || '';
    let body;
    const raw = await res.text();
    if (ct.includes('json')) {
      try { body = JSON.parse(raw); } catch { body = raw; }
    } else {
      body = raw.length > 4000 ? raw.slice(0, 4000) + '…[truncated]' : raw;
    }
    entry = {
      ...entry,
      status: res.status,
      ok: res.ok,
      content_type: ct,
      ms: Date.now() - started,
      body,
    };
  } catch (e) {
    entry = { ...entry, error: String(e), ms: Date.now() - started };
  }
  const file = save(name, entry);
  const tag = entry.error ? 'ERR' : entry.status;
  console.log(`  [${tag}] ${entry.method} ${url}  →  ${path.basename(file)}`);
  return entry;
}

(async () => {
  console.log('Lobo sandbox probe');
  console.log('  base:', BASE);
  console.log('  out :', OUT, '\n');

  // 1) TOKEN — Basic Auth, ingen body. Forventer { token, ... } + udløb.
  console.log('1) Token (POST /token, Basic Auth)');
  const basic = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
  const tokenEntry = await probe('01_token', BASE + 'token', {
    method: 'POST',
    headers: { Authorization: basic, Accept: 'application/json' },
  });

  let token = null;
  if (tokenEntry.body && typeof tokenEntry.body === 'object') {
    token = tokenEntry.body.token || tokenEntry.body.access_token
         || tokenEntry.body.jwt || tokenEntry.body.bearer || null;
  }
  if (!token) {
    console.error('\nIngen token i svaret — kan ikke fortsætte med beskyttede kald.');
    console.error('Se /tmp/lobo-probe/01_token.json for det fulde svar.');
    process.exit(2);
  }
  const auth = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  console.log('   token fanget ✓\n');

  // Bekræftet fra JWT-payload + Postman-rute-liste (api.lobo.at):
  //   - fk_customer = custom_customernumber i token (her 18062101)
  //   - rute-navne uden bindestreg: webhookevents, pricescales, orderdrafts, places …
  //   - /addresses/verify er POST (GET → 405)
  // ALLE kald nedenfor er GET (read-only). Kræver at API-brugeren har scopes.
  const routes = [
    // [filnavn, sti] — produkt + pris (V2: margin-grundlag)
    ['02_products',            'products'],
    ['03_products_embed',      'products?_embed=pricescales,surcharges'],
    ['04_pricescales',         'pricescales'],
    ['05_surcharges',          'surcharges'],
    ['06_orderpricescaleqty',  'orderpricescalequantities'],
    ['07_ordersurchargeqty',   'ordersurchargequantities'],
    // webhooks (V3: event-navne + eksisterende registreringer)
    ['08_webhookevents',       'webhookevents'],
    ['09_webhooks_list',       'webhooks'],
    // ordrer + relationer (V4: shape til snapshot + body-felter)
    ['10_orders_list',         'orders'],
    ['11_orderdrafts',         'orderdrafts'],
    ['12_stops',               'stops'],
    ['13_places',              'places'],
    ['14_customers',           'customers'],
    ['15_paymentmethods',      'paymentmethods'],
    // diverse
    ['16_config',              'config'],
    ['17_status',              'status'],
  ];
  console.log('Read-only discovery (kræver scopes på API-brugeren):');
  for (const [name, p] of routes) {
    await probe(name, BASE + p, { headers: auth });
  }

  // Adresse-verify er POST. Vi kender ikke body-shapen endnu — denne kalder med
  // en minimal gæt-body for at se fejlbeskeden (afslører påkrævede felter).
  console.log('Adresse-verify (POST — afslører påkrævede felter via fejl):');
  await probe('18_addr_verify_post', BASE + 'addresses/verify', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ street: 'Nørrebrogade', housenumber: '40', city: 'København', zip: '2200', country: 'DK' }),
  });

  console.log('\nFærdig (discovery). Fixtures i', OUT);
  console.log('Næste: gennemgå svarene, fastlæg fk_customer + produkt-id, så kan en');
  console.log('guidet testordre køres med LOBO_BOOK_TEST=1 (separat, bevidst write).');

  // ── Valgfri WRITE: testordre. Køres KUN hvis LOBO_BOOK_TEST=1 ──────────────
  // Body-shapen er IKKE bekræftet endnu — udfyld fk_customer/fk_product/fk_place
  // fra discovery-svarene før du slår dette til.
  if (process.env.LOBO_BOOK_TEST === '1') {
    console.log('\n[WRITE] LOBO_BOOK_TEST=1 — booker testordre …');
    const body = JSON.parse(process.env.LOBO_TEST_BODY || '{}');
    await probe('20_order_create', BASE + 'orders', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
})();
