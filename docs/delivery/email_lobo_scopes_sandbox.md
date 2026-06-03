# Udkast — mail til Lobo (Jürgen) om scopes + sandbox

> To: info@lobo.at (Jürgen Kurzmann) · Cc: sebastian@by-expressen.dk
> Subject: Ristet Rug — API v3 scopes + sandbox (HTTP 500)

---

Hi Jürgen,

We're building the API v3.1 integration for Ristet Rug (customer no. **18062101**, API user `ristetrug18062101`) to create cycle-courier orders automatically and receive status/POD back via webhook. Authentication already works (`POST /token` returns a valid JWT), but we've hit two things:

**1. The API user has no scopes**

Every authenticated resource call returns `403 "Not in scope: token is not allowed to ..."`, and the decoded token shows `"scope": []`. Could you enable the following scopes for the user `ristetrug18062101` in the LOBO frontend (or let me know if we can do this ourselves under *System → API access* and how)?

```
address.verify
address.autocomplete:streets_and_places
product.read
surcharge.read
payment.read
order.read
order.create
order.edit
order.delete
orderdraft.read
orderdraft.create
orderdraft.edit
orderdraft.order
orderdraft.delete
ordersurchargequantity.read
ordersurchargequantity.set
ordersurchargequantity.delete
orderpricescalequantity.read
stop.read
customer.read
place.read:used_before
place.read:all
webhook.read
webhook.create
webhook.delete
webhookevent.read
embed.order:downloadlinks
statistic.read
```

**2. The sandbox is returning HTTP 500**

`https://byexpressen.lobolink.eu/lobo/sandbox/api/v3/public/` returns an empty-body HTTP 500 on every route (including the root and `/token`). The productive base on the same host responds correctly (`401 "Token not found."` at root). We'd like to do all booking/cancel/webhook testing against sandbox before going live — could you check the sandbox environment?

A couple of quick confirmations would also help:
- For the **productive** environment, is the same user/credentials valid, or do we get separate productive credentials?
- Which **product id** is the standard Copenhagen cycle courier (`GET /products`), and the relevant **payment id** (`GET /payments`)? We'll read these via the API once scopes are enabled, but a pointer saves a round-trip.

Thanks a lot,
Leif — Ristet Rug

---

## Dansk version (hvis du hellere skriver til Sebastian)

Hej Sebastian,

Vi er i gang med API v3.1-integrationen, så vi automatisk kan oprette cykelbud-ordrer hos jer og få status + kvittering (POD) retur via webhook. Login virker (token kommer fint retur), men vi mangler to ting fra Lobo/Jürgen:

1. **Scopes** — vores API-bruger (`ristetrug18062101`, kundenr 18062101) har ingen scopes, så alle kald giver 403. Listen over de scopes vi skal bruge står ovenfor (engelsk).
2. **Sandbox er nede** — `…/lobo/sandbox/api/v3/public/` svarer HTTP 500 på alt. Vi vil gerne teste booking mod sandbox før vi går live. Kan I få den tjekket?

Og gerne en bekræftelse på: hvilket produkt-id er standard cykelbud i København, og kan vi selv sætte scopes i LOBO-frontenden under System → API access, eller skal Jürgen gøre det?

Tak!
