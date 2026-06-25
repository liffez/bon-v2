# E-conomic — kom i gang

Det her er din tjekliste. Når den er kørt igennem, kan Simon bygge resten uden
at vente. Del 2 nederst klippes ind i `CLAUDE.md` under "Næste opgave".

---

## DEL 1 — Hvad DU skal gøre (Leif)

### A. De to tokens ✅ KLARET

`/self` svarer korrekt — begge tokens er gyldige. (Hvis du senere skal lave det
om: AppSecretToken nulstilles under app'en, grant-token via Installations-URL'en
fra RR's regnskab.)

### B. To RR-tal Simon skal bruge ✅ FUNDET

- [x] **paymentTermsNumber = `1`** (Netto 8 dage) — jeres standard fra `/self`.
- [x] **layoutNumber = `19`** (DK std. m. bankoplys.).

Begge lægges i `settings` (ikke `.env`, ikke hardcoded):
`economic_default_payment_terms_number = 1`, `economic_layout_number = 19`.

**Bemærk:** Regnskabet hedder **Nordic Fast Food** (RR's CVR-selskab, CVR
27606644) — det er afsenderen på fakturaerne. Appens rolle er "Sales", hvilket
dækker fakturering. Til bank-reconciliation senere kan en bredere rolle/ny
token blive nødvendig.

### C. Produkt-mapping i Grocy (på RECIPES — ikke products)

> Vi sælger Grocy-**recipes** (sandwich, salat …) — det er deres numre der står i
> fakturaens "Nr."-kolonne (30, 16, 74 …). Userfeltet skal derfor ligge på recipes.
> Levering + gebyrer er ikke recipes; deres varenr bor på køretøjet/settings.

- [ ] **Opret userfield i Grocy.** Manage master data → Userfields → entity =
      **recipes** → nyt felt, navn `economic_product_number`, type tekst.
- [ ] **Backfill manuelt.** For hver eksisterende recipe: slå dens nummer op
      i e-conomic og tast det i det nye felt. *Regel: udfyld kun hvis tomt —
      rør aldrig et nummer der allerede står der.*
- [ ] **Fremover:** Når du opretter en ny recipe/vare i e-conomic, tast nummeret
      ind i Grocy-feltet med det samme. (Automatik bygges først hvis det bliver
      for besværligt.)

---

## DEL 2 — Næste opgave (klip ind i CLAUDE.md)

```markdown
## Næste opgave — E-conomic faktura-integration

Specs: CLAUDE_ECONOMIC_AUTH.md (forbindelse) + CLAUDE_ECONOMIC_ADAPTER.md (payload).

### Spor 1 — Auth-lag (kan startes NU, uafhængigt af RR-tal)
1. Tilføj til .env: ECONOMIC_APP_SECRET_TOKEN, ECONOMIC_AGREEMENT_GRANT_TOKEN,
   ECONOMIC_REST_BASE, ECONOMIC_OPENAPI_BASE (se AUTH §3).
2. services/economicAdapter.js — auth-wrapper med begge headers,
   rest()/openapi()-indgange, fejlklasser for 401/429 (se AUTH §4–5).
3. Verificér server-side: GET /self returnerer "Ristet Rug". GATE før spor 2.

### Spor 2 — Faktura-adapter (afventer settings + Grocy-backfill)
Forudsætter: settings-værdier nedenfor + userfield economic_product_number i
Grocy udfyldt + ny kolonne på delivery_vehicles.
4. Migration: kolonne economic_product_number på delivery_vehicles. Sæt
   17 (bike), 103 (own-bike), 103 (volvo), 100 (taxi).
5. grocyAdapter eksponerer economic_product_number pr. RECIPE (slås op på grocy_recipe_id).
   Adapter-query joiner delivery_vehicles → delivery_vehicle_economic_product_number.
6. buildDraftInvoice(bon) — payload pr. ADAPTER-spec. Tre linjekilder:
   bon_lines (recipe-varenr), levering (køretøj-varenr, fallback 17),
   miljøbidrag (varenr 98). Ex moms via shared/moms.js, vatZone {vatZoneNumber:1},
   rabat = offer_discount_percent som discountPercentage pr. linje, idempotency-key.
7. Forhåndstjek: bloker hvis kunde-nr ELLER en linjes recipe-nr mangler.
8. KUN udkast: POST /invoices/drafts → gem draftInvoiceNumber på bon → STOP.
   Et menneske bogfører manuelt i e-conomic. Vi kalder ALDRIG /invoices/booked,
   og sætter ikke selv FAKTURERET (følger via reconciliation).
9. Aktivér test #7 i tests/moms_audit_e2e.test.js.
10. Migration: trigger bons_seed_standing_discount (stående kunderabat → offer_discount_percent).

### Konfiguration (lægges i settings)
- economic_default_payment_terms_number = 1   (Netto 8 dage)
- economic_layout_number = 19                 (DK std. m. bankoplys.)
- economic_delivery_fallback_product_number = 17
- economic_fee_product_number_miljobidrag = 98
  (kortbetaling 99 + ekspres 64 forberedt, inaktive til felter findes)

### Stadig blokeret
- [x] Tokens verificeret (/self svarer — firma = Nordic Fast Food)
- [x] paymentTermsNumber = 1
- [x] layoutNumber = 19
- [x] Leverings-varenr afklaret (17/103/103/100 + fallback 17)
- [ ] Grocy-userfield economic_product_number oprettet + backfillet
- [ ] delivery_vehicles.economic_product_number kolonne + værdier
```
