# Udkast — mail til Lobo (Jürgen) om order.delete-scope + sandbox

> To: info@lobo.at (Jürgen Kurzmann) · Cc: sebastian@by-expressen.dk
> Subject: Ristet Rug — API v3: order.delete scope + sandbox (HTTP 500)

---

Hi Jürgen,

We're building the API v3.1 integration for Ristet Rug (customer no. **18062101**, API user `ristetrug18062101`) to create courier orders automatically and receive status/POD back via webhook. Auth + scopes (requested in the token body) work well — we can already read products, surcharges and webhook events. Two things remain:

**1. Please enable the `order.delete` scope (and ideally `payment.read`, `statistic.read`)**

Most scopes are enabled. A few that we request in the token body are dropped (not allowed for the user): `order.delete`, `payment.read`, `statistic.read`, `place.read:all`. We specifically need **`order.delete`** to be able to cancel a booking via the API. Could you enable it for `ristetrug18062101` (and ideally `payment.read` + `statistic.read` too)?

**2. The sandbox is returning HTTP 500**

`https://byexpressen.lobolink.eu/lobo/sandbox/api/v3/public/` returns an empty-body HTTP 500 on every route (root, `/token`, everything). The productive base on the same host responds correctly. We need a working sandbox to test order creation / cancel / webhooks before going live — could you check the sandbox environment?

One confirmation on **webhooks**: we'll subscribe to `order.dispatched`, `order.stopvisitedorsigned`, `order.finished`, `order.trashed`/`order.withdrawn` via `POST /webhooks` and verify incoming calls using the per-webhook `hmac_key`. Could you confirm exactly **what string the HMAC signature is computed over** (full URL incl. query parameters? query string only?) and **which header** carries the signature? That's the one detail we can't determine without a live sandbox callback.

Thanks a lot,
Leif — Ristet Rug

---

## Dansk version (hvis du hellere skriver til Sebastian)

Hej Sebastian,

Vi er langt med API v3.1-integrationen — login + scopes virker, og vi kan allerede hente produkter, tillæg og webhook-events. To ting mangler vi fra Lobo/Jürgen:

1. **`order.delete`-scope** skal slås til på vores API-bruger (`ristetrug18062101`) — ellers kan vi ikke afbestille en booking via API'et. Gerne også `payment.read` + `statistic.read`.
2. **Sandbox er nede** — `…/lobo/sandbox/api/v3/public/` svarer HTTP 500 på alt. Vi skal bruge sandbox til at teste oprettelse/afbestilling/webhooks før vi går live.

Og gerne en bekræftelse på webhook-signaturen: hvad beregnes HMAC'en over (hele URL'en inkl. query, eller kun query-strengen), og hvilken header indeholder signaturen?

Tak!
