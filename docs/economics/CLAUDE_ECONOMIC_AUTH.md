# CLAUDE_ECONOMIC_AUTH.md — Auth- og credential-lag

> **Tillæg til `CLAUDE_ECONOMIC_ADAPTER.md`.** Dette dokument dækker KUN
> forbindelsen til e-conomic (tokens, API-baser, fejlhåndtering). Selve
> bon → faktura-mapningen (moms pr. linje, payload-struktur) hører i
> `CLAUDE_ECONOMIC_ADAPTER.md` og dubleres ikke her.
>
> **Afgrænsning:** Token-anskaffelse er en manuel engangs-handling Leif
> udfører i e-conomics portal. Den kan ikke automatiseres af koden. Dette
> spec dækker hvordan adapteren *bruger* de tokens, ikke hvordan de skaffes.

---

## 1. Token-model (to tokens, to logins)

e-conomic bruger en **kombineret nøgle af to tokens**. Begge sendes som
HTTP-headers på hvert kald. Query-string-auth understøttes IKKE (kun til demo).

| Token | Header | Identificerer | Kommer fra |
|-------|--------|---------------|------------|
| **AppSecretToken** | `X-AppSecretToken` | Vores integration | Developer agreement → Apps. Vises kun én gang; `reset` giver en ny |
| **AgreementGrantToken** | `X-AgreementGrantToken` | Ristet Rugs regnskabsdata | Installation URL kørt mens man er logget ind på Ristet Rugs e-conomic-konto |

**Vigtigt:** De to tokens kommer fra **to forskellige logins** — developer
agreement (apps) og det almindelige Ristet Rug-regnskab (grant). Det er den
hyppigste kilde til forvirring.

**Rolle:** Sæt app'ens rolle til **SuperUser** i e-conomic (Indstillinger →
Udvidelser → Apps → app → Rolle) for fuld læseadgang til fakturaer og
bogførte poster.

---

## 2. To API-baser — funktionalitet er splittet

e-conomic har **to aktive API'er**. Adapteren skal kunne tale med begge.

| API | Base-URL | Bruges til |
|-----|----------|------------|
| **REST API** | `https://restapi.e-conomic.com` | Kunder, fakturaudkast (`/invoices/drafts`), bogførte fakturaer (`/invoices/booked`) |
| **OpenAPI** | `https://apis.e-conomic.com` | Bogførte poster / betalingsafstemning (`bookedentries`, `matched booked entries`) |

**Begge** bruger de samme to headers til auth. Forskellen er pagination:
REST bruger `nextPage`-links, OpenAPI bruger cursor-baseret pagination —
ingen offset/jump-til-side. Pagineringshjælpere skal håndtere begge mønstre.

---

## 3. .env (krypteret at-rest, aldrig i git)

```
ECONOMIC_APP_SECRET=...            # X-AppSecretToken  (deployet navn)
ECONOMIC_AGREEMENT_GRANT=...       # X-AgreementGrantToken  (deployet navn)
# Baser er valgfri — adapteren defaulter til disse:
ECONOMIC_REST_BASE=https://restapi.e-conomic.com
ECONOMIC_OPENAPI_BASE=https://apis.e-conomic.com
```

> Navne: `ECONOMIC_APP_SECRET` / `ECONOMIC_AGREEMENT_GRANT` er de faktiske, deployede navne
> (verificeret 25. juni — `/self` → "Nordic Fast Food", agreement 1073932). Adapteren accepterer
> også `*_TOKEN`-varianterne som alias, så begge virker.

- Tokens dekrypteres **kun server-side** i selve kald-øjeblikket.
- Aldrig til browseren — frontend ser højst en maskeret version (sidste 4 tegn).
- `.env` er allerede i `.gitignore` (jf. BON_V2_PRINCIPPER §5).

---

## 4. Auth-wrapper (`services/economicAdapter.js`)

Én wrapper-funktion sætter begge headers på alle kald — gentag dem aldrig
manuelt pr. endpoint. Bruger `node:fetch` (ingen ny npm-pakke nødvendig,
jf. princip om stdlib-first).

```js
// services/economicAdapter.js
const REST = process.env.ECONOMIC_REST_BASE;
const OPENAPI = process.env.ECONOMIC_OPENAPI_BASE;

function authHeaders() {
  return {
    'X-AppSecretToken': process.env.ECONOMIC_APP_SECRET_TOKEN,
    'X-AgreementGrantToken': process.env.ECONOMIC_AGREEMENT_GRANT_TOKEN,
    'Content-Type': 'application/json',
  };
}

async function ecoFetch(base, path, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = authHeaders();
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    // Grant token tilbagekaldt i e-conomic → kræver ny grant
    throw new EconomicAuthError('e-conomic-adgang skal genetableres (401)');
  }
  if (res.status === 429) {
    throw new EconomicRateError('e-conomic rate limit ramt (429)');
  }
  if (!res.ok) {
    const text = await res.text();
    throw new EconomicError(`e-conomic ${res.status}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

// Bekvemme indgange pr. base
const rest = (path, opts) => ecoFetch(REST, path, opts);
const openapi = (path, opts) => ecoFetch(OPENAPI, path, opts);
```

**Idempotency:** Ved POST (oprettelse af fakturaudkast) sæt en stabil
`Idempotency-Key` — fx `bon-${bon_id}-draft` — så et gentaget kald efter
netværksfejl ikke laver dubletter. Caches hos e-conomic i 1 time. Gælder
ikke GET.

---

## 5. Fejlhåndtering

| HTTP | Betydning | Adapterens reaktion |
|------|-----------|---------------------|
| `401` | Grant token tilbagekaldt / ugyldig | Stop, vis "e-conomic skal genforbindes" i office. Tokens er ikke selvfornyende — kræver manuel ny grant |
| `403` | Authentificeret, men rolle mangler adgang | Log + besked: tjek app-rolle (SuperUser) |
| `429` | Over rate limit | Backoff + retry. Fair use = 50.000 kald/24t pr. agreement |
| `500` | e-conomic-fejl | Log `X-...`-id + agreement-nr (kræves ved support til api@e-conomic.com) |

**Pagination (REST):** maks. 1.000 records pr. side; følg `nextPage`-link.
Hent ikke faktura-detaljer sekventielt i loop — batch i grupper for at undgå 429.

---

## 6. Verifikation efter token-anskaffelse

Før adapteren bygges videre — bekræft at begge tokens er gyldige med ét kald:

```bash
curl -s https://restapi.e-conomic.com/self \
  -H "X-AppSecretToken: $ECONOMIC_APP_SECRET_TOKEN" \
  -H "X-AgreementGrantToken: $ECONOMIC_AGREEMENT_GRANT_TOKEN" | jq .companyName
```

Returnerer den **Ristet Rug** → begge tokens virker, og vi kan bygge videre
på `CLAUDE_ECONOMIC_ADAPTER.md`. Returnerer den 401 → forkert/tilbagekaldt grant.

(Demo-test uden tokens: `X-AppSecretToken: demo` + `X-AgreementGrantToken: demo`
— men kun GET virker på demo.)

---

## 7. Forhold til reconciliation-sporet

Betalingsafstemning (cashflow) bygger på OpenAPI'ens `bookedentries` +
`matched booked entries`, der linker kundebetalinger til salgsfakturaer.
Fakturanummer er matching-key (jf. tidligere beslutning). `dueAmount: 0` på
en bogført faktura = betalt. Detaljer hører i cashflow/reconciliation-specet,
ikke her — dette dokument leverer kun `openapi()`-forbindelsen de skal bruge.

---

## Næste opgave (forslag til CLAUDE.md)

1. **Leif:** Skaf de to tokens (developer agreement → AppSecretToken;
   Installation URL fra RR-regnskab → AgreementGrantToken). Sæt app-rolle =
   SuperUser. Verificér med `/self`-kaldet i §6.
2. **Simon:** Tilføj `.env`-variabler (§3) + `services/economicAdapter.js`
   auth-wrapper (§4) med fejlklasser (§5).
3. Bekræft `/self` returnerer "Ristet Rug" fra serveren — *gate inden
   payload-arbejde*.
4. Først derefter: byg bon → faktura-draft fra `CLAUDE_ECONOMIC_ADAPTER.md`.
