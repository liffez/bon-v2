# CLAUDE_ECONOMIC_PLAN.md — Implementerings- og testplan

> Læs FØRST: `CLAUDE_ECONOMIC_AUTH.md` (forbindelse) + `CLAUDE_ECONOMIC_ADAPTER.md` (payload).
> Denne fil er *hvordan vi bygger og tester det* — ikke en gentagelse af payload/auth.
> Status: ikke bygget. Plan skrevet 25. juni 2026 (grounded mod faktisk kode).
>
> **Ny session der skal bygge dette:** læs alle 4 filer i `docs/economics/` (AUTH, ADAPTER,
> KOM_IGANG, PLAN). Alle beslutninger er taget og står i "AFKLARET". Start med Spor 1 (auth) —
> det har ingen afhængigheder. Bygges via dry-run/preview + branch-test FØR go-live
> (se "TESTSTRATEGI FØR GO-LIVE"). Specs er sandheden; spørg ikke om det der allerede er besluttet.

---

## Overblik — 4 spor, byg i rækkefølge

| Spor | Indhold | Afhænger af | Kan startes |
|------|---------|-------------|-------------|
| **1. Auth** | `economicAdapter.js` forbindelse + `/self`-gate | Tokens (✅ i hus) | NU |
| **2. Faktura-udkast** | `buildDraftInvoice` + endpoint + UI-knap + rabat-trigger | Spor 1 + settings + Grocy-backfill | efter spor 1 |
| **3. EAN/offentlig** | Rekvisitionsfelt + Nemhandel-kanal | Spor 2 + ekstern opsætning | senere fase |
| **4. Reconciliation** | Auto-match betaling → FAKTURERET via OpenAPI | Spor 2 + cashflow-sporet | senere fase |

Spor 1+2 giver fuld manuel drift (udkast oprettes fra Bon v2, mennesket bogfører i e-conomic).
Spor 3+4 er separate, ikke cutover-blokkere.

---

## Centralt workflow — BESLUTTET (25. juni 2026): overstregning, bons bliver i køen

> **Beslutning:** Alle leverede bons der ikke er betalt kontant bliver i fakturerings-køen
> ("Afventer fakturering") og **bliver dér indtil de faktisk er faktureret** — så der er
> overblik. Vi indfører IKKE en separat status. Når et udkast er sendt, vises bonen
> **overstreget** i køen (samme look som fakturerede bons). Bonen flytter til
> "Faktureret"-sektionen først når den markeres faktureret.

Vi opretter **kun et udkast** og bogfører aldrig automatisk. Men den nuværende
fakturerings-kø (`routes/invoices.js` → `GET /api/invoices/queue`) viser bons med
`status='LEVERET' AND payment_type='invoice'`. Hvis vi blot opretter et udkast uden
at ændre noget, bliver bonen i køen → office sender den igen → **dublet-udkast**.

**Forslag (fase 1, ingen reconciliation krævet endnu):**
1. Migration: `bons.economic_draft_number` (INTEGER) + `economic_draft_at` (TEXT).
2. Når udkast oprettes: gem begge. Bonen **bliver i "Afventer fakturering"-køen, men vises
   OVERSTREGET** (samme strikethrough-look som de allerede-fakturerede bons i listen) — så
   office kan se hvilke der er sendt til e-conomic og venter på godkendelse, uden at de
   forsvinder fra overblikket. "Send til e-conomic"-knappen skifter til "Genåbn i e-conomic".
3. Office bogfører manuelt i e-conomic → klikker den **eksisterende** "Markér faktureret"-knap
   i Bon v2 → status `FAKTURERET` + (valgfrit) `invoice_number` → bonen flytter til
   "Faktureret"-sektionen.
4. Re-send-guard: er `economic_draft_number` sat, byg ikke et nyt udkast (vis i stedet
   "udkast findes allerede").

> **Visuelt skel:** overstreget i *Afventer* = udkast sendt, venter på din godkendelse i e-conomic.
> Overstreget i *Faktureret* = helt færdig. Begge er overstregede, men ligger i hver sin sektion.

**Link til e-conomic (opdateret 25. juni 2026 m. observerede URL-mønstre) — VALGFRIT, degraderer pænt.**

Observerede URL'er i e-conomic-UI'et:
| Hvad | URL | Brugbarhed |
|------|-----|-----------|
| Kladde — REST (API) | `restapi.e-conomic.com/invoices/drafts/{draftInvoiceNumber}` | ✅ dokumenteret. Kladden har sit EGET nummer (`draftInvoiceNumber`), auto-tildelt + returneret i POST-svaret. Men dette er en JSON/API-adresse — ikke til browseren |
| Kladde — web-UI | `secure.e-conomic.com/sales/invoicing/invoices/{internt_web_id}` | ⚠️ web-id ≠ draftInvoiceNumber (skærmbillede: `/invoices/369` men titel "Fakturanr. 4113"). API'et giver os 4113, ikke 369 → web-deeplinket kan IKKE bygges fra API-svaret |
| Bogført faktura (PDF) | `secure.e-conomic.com/secure/include/visfaktura.asp?ops={ops}&bogf=1&faknr={fakturanr}` | ✅ `faknr` = det rigtige fakturanr. ⚠️ `ops` (fx 28745949) uvist om stabilt pr. agreement el. pr. dokument |
| Kladde-liste | `secure.e-conomic.com/sales/invoicing/invoices` | ✅ virker altid (generelt) |
| Arkiv (bogførte) | `secure.e-conomic.com/sales/invoicing/archive` | ✅ virker altid (generelt) |

**Design (robust, uafhængigt af om deep-link kan bygges):**
- **Altid:** vis `economic_draft_number` på den overstregede bon.
- **Kladde-link:** vi har `draftInvoiceNumber` fra API'et (kladdens eget nr.), men web-UI-id'et
  kan vi ikke aflede → vis nummeret + det generelle kladde-liste-link. Én test ved build afgør om
  vi kan gøre det bedre: prøv manuelt `secure.e-conomic.com/sales/invoicing/invoices/{draftInvoiceNumber}`
  — hvis UI'et også accepterer kladdens eget nummer dér, kan vi alligevel bygge et per-kladde-link.
- **Bogført-link (når bonen er faktureret):** byg PDF-link af `invoice_number` + `economic_ops`
  (settings) → pålideligt link til den endelige faktura i arkivet. Bekræft at `ops` er stabilt;
  ellers brug det generelle arkiv-link.

Ingen funktionalitet afhænger af at et deep-link kan bygges — det er ren bekvemmelighed oven på nummeret.

**At afklare ved build (Simon, med login) — 5-sekunders tests:** (1) accepterer web-UI'et kladdens
eget `draftInvoiceNumber` i URL'en (`/sales/invoicing/invoices/{draftInvoiceNumber}`)? Hvis ja →
per-kladde-link virker alligevel. (2) er `ops` i `visfaktura.asp` stabilt pr. agreement (så det
kan ligge fast i settings)? Begge er ja/nej der ikke blokerer noget — kun om linket bliver
per-dokument eller generelt.

> **Bekræftet i e-conomics REST-docs (25. juni):** `draftInvoiceNumber` er kladdens eget,
> auto-tildelte nummer; REST self = `restapi.e-conomic.com/invoices/drafts/{draftInvoiceNumber}`;
> bogføring giver et separat `bookedInvoiceNumber`. API'et dokumenterer altså nummersystemet —
> det er kun det interne *web-UI*-id (369-typen) der ikke eksponeres via API.

**Tæller på ventende kladder (tilføjet 25. juni 2026):** Vis et tal "N kladder venter på
godkendelse" (bons med `economic_draft_number` sat MEN endnu ikke faktureret) — som et ekstra
kort i fakturerings-summary-striben (ved siden af "Afventer fakturering"/"Ufaktureret beløb")
og evt. som badge på Økonomi-nav-punktet. Gør det synligt at noget ligger og venter på et
menneske i e-conomic. Tælles via `COUNT(*) WHERE economic_draft_number IS NOT NULL AND status='LEVERET'`.

Det respekterer "kun draft" + bevarer det manuelle godkendelsestrin, uden at vente på
spor 4. Reconciliation (spor 4) automatiserer senere trin 3.

Badge er mindst invasivt og rører ikke status-maskinen/transitions. Køens medlemskab er
uændret (leveret + ikke kontant); udkastet ændrer kun visningen, ikke hvornår bonen forlader køen.

---

## SPOR 1 — Auth-lag

**Filer:** `.env` (+ `.env.example`), `services/economicAdapter.js`, `server.js` (intet mount nødvendigt — adapter er et service-modul).

1. `.env`: `ECONOMIC_APP_SECRET_TOKEN`, `ECONOMIC_AGREEMENT_GRANT_TOKEN`,
   `ECONOMIC_REST_BASE=https://restapi.e-conomic.com`, `ECONOMIC_OPENAPI_BASE=https://apis.e-conomic.com`.
2. `services/economicAdapter.js` (AUTH §4): `authHeaders()`, `ecoFetch()`, `rest()`, `openapi()`,
   fejlklasser `EconomicAuthError`/`EconomicRateError`/`EconomicError`. `node:fetch` — ingen npm-pakke.
3. `getSelf()` → `rest('/self')`. Verificér server-side at `companyName` indeholder Nordic Fast Food.

**Gate:** Ingen payload-arbejde før `/self` svarer korrekt fra serveren.

---

## SPOR 2 — Faktura-udkast

### Datagrundlag (Leif/office, manuelt — engangs)
- [ ] Grocy userfield `economic_product_number` på entitet **recipes** + backfill (KOM_IGANG §C).
- [ ] Settings-rækker (key/value i `settings`-tabellen):
  `economic_default_payment_terms_number=1`, `economic_layout_number=19`,
  `economic_delivery_fallback_product_number=17`,
  `economic_draft_url` (VALGFRI — kladde-link; per-kladde hvis internt id kendes, ellers generelt
  kladde-liste-link, ellers tom),
  `economic_invoice_url` + `economic_ops` (VALGFRI — bogført-faktura-PDF-link via `visfaktura.asp?ops={ops}&bogf=1&faknr={nr}`),
  `economic_oneoff_product_number` (engangsvare-nr til linjer uden rigtigt nummer — overskriv tekst+beløb).
  (Ingen miljøgebyr-setting — miljøgebyr er en Grocy-recipe og kommer med som almindelig linje.)
- [ ] `delivery_vehicles.economic_product_number` udfyldt pr. køretøj (17/103/103/100) —
  bruges KUN til det nye logistik-systems linjeløse levering.
- [ ] e-conomic: bekræft momskode pr. varenr — bidrag (98) = momspligtig, afgift-varer = momsfri.

### Kode
1. **Migration (ny, fx `105_economic.sql`):**
   - `ALTER TABLE delivery_vehicles ADD COLUMN economic_product_number INTEGER;`
   - `ALTER TABLE bons ADD COLUMN economic_draft_number INTEGER;`
   - `ALTER TABLE bons ADD COLUMN economic_draft_at TEXT;`
   - Seed de 3 settings-rækker (INSERT OR IGNORE) — payment_terms(1), layout(19), delivery_fallback(17).
2. **Migration (ny, fx `106_standing_discount.sql`):** trigger `bons_seed_standing_discount`
   (ADAPTER → RABAT-sektionen). AFTER INSERT, `WHEN offer_discount_percent IS NULL OR = 0`,
   COALESCE firma- så kunde-`discount_percent`.
   - Engangs-backfill af *eksisterende ufakturerede* bons er IKKE en del af triggeren —
     besluttet: INGEN tilbagevirkende kraft (kun nye bons).
3. **`grocyAdapter`:** ny `getEconomicProductMap()` → map `recipe_id → economic_product_number`
   bygget fra **`getRecipesRawMap()`** (IKKE `getRecipes()`, som filtrerer `sellable=1` —
   en bon kan faktureres efter sæson hvor recipe er `sellable=0`). Cache + invalidation som øvrige.
4. **`services/economicAdapter.js`:** `getEconomicSettings()` (lokal settings-læser, jf.
   mønster i `routes/booking.js`), `resolveEconomicCustomer()`, `buildReference()`,
   `buildDraftInvoice(bon)`, `createDraftInvoice(bon)` (forhåndstjek → POST `/invoices/drafts`
   med Idempotency-Key → returnér `draftInvoiceNumber`).
5. **`routes/invoices.js`:**
   - Berig kø-bons' linjer med `economic_product_number` (join via `getEconomicProductMap()`)
     + `delivery_vehicle_economic_product_number`/`_label` (join `delivery_vehicles`).
   - `POST /api/invoices/:bonId/economic-draft` → `requireAuth()` → `createDraftInvoice` →
     gem `economic_draft_number`+`economic_draft_at` → changelog + SSE `bon_updated`.
   - Forhåndstjek-endpoint (eller del af samme svar): returnér 422 + liste over manglende
     recipe-/kunde-numre i stedet for at bygge payloaden.
   - Kø-response inkluderer `economic_draft_number` + (valgfrit) `economic_draft_url` (kun hvis
     settings-skabelon er sat) + en tæller "kladder venter" til summary-striben.
6. **`office/views/fakturering.js`:**
   - "Send til e-conomic"-knap pr. bon → kald endpoint → vis bonen **overstreget** + draft-nr;
     fejl (422) → vis blokeringsliste. Bevar "Markér faktureret".
   - På overstregede (udkast-sendt) bons: altid vis draft-nr; **"Åbn kladde i e-conomic →"**-link
     KUN hvis `economic_draft_url` er sat (degraderer pænt hvis deep-link ikke findes).
   - Nyt summary-kort **"Kladder venter · N"** + evt. badge på Økonomi-nav.
7. **`shared/api.js`:** `createEconomicDraft(bonId)`.
8. **Kunde/kontakt-oprettelse (dokument-flow):** når kunde- eller kontaktnummer mangler, generér
   et clipboard/dokument med info (genbrug delivery-popout-mønstret) → office opretter i e-conomic
   → taster nummer tilbage på firma/kunde. (API-oprettelse `POST /customers` som senere forbedring.)
9. **Engangsvare-fallback:** linje uden recipe-nummer kan bruge `economic_oneoff_product_number`
   med overskrevet `description` + `unitNetPrice` (i stedet for hård blokering for engangsting).

### Payload-detaljer
Følg `CLAUDE_ECONOMIC_ADAPTER.md` 1:1: ex moms via `shared/moms.js`, `date=todayISO()`,
`delivery`-objekt, `references.other`, rabat som `discountPercentage` pr. linje, ALLE linjer
inkl. `is_accessory`. Levering/miljøgebyr/service er Grocy-recipes → normale linjer (kun det nye
logistik-systems linjeløse `delivery_price` syntetiseres fra køretøjets varenr).

---

## SPOR 3 — EAN/offentlig (VIGTIG — stor andel af kunderne; ikke udskudt)
**Opdateret 25. juni:** EAN er IKKE en separat kanal vi skal bygge. e-conomic sender selv EAN
ved bogføring (kræver CVR på agreement ✅ + EAN + kontaktperson på kunden). Derfor:
- EAN-kunder behandles som **almindelige draft-fakturaer** — ingen blokering bare fordi de er EAN.
- Forhåndstjek: EAN-kunde (`company.ean` sat) UDEN kontaktperson (`economic_contact_id`) → blokér
  med klar besked (ellers fejler e-conomics bogføring).
- Rekvisition leveres af kunden når påkrævet → `references.other` (via `buildReference`).
- Mennesket bogfører i e-conomic UI → EAN sendes automatisk.
- **Fase 2 (valgfri automatisering):** `POST /invoices/booked` med `sendBy: "ean"` + spor via
  `GET /invoices/sent`. Bryder bevidst "kun draft" for offentlige — separat beslutning.

## SPOR 4 — Reconciliation (senere, hører til cashflow)
- OpenAPI `bookedentries` + matched entries → match betaling/bogføring på `invoice_number`,
  sæt `FAKTURERET`/`BETALT`. Erstatter det manuelle trin 3 i workflow-valget.

---

## TESTPLAN

Mønster som resten af projektet: unit + integration mod isoleret test-DB, plus manuel e2e.
Specs i `tests/specs/T_ECONOMIC.md`, runner i `tests/scripts/run_T_economic.js`.

### Unit (ingen netværk — mock `ecoFetch`/grocy)
1. **moms #7** (eksisterende placeholder): `buildDraftInvoice(T5)` → ex-moms-linjesum ≈ 18.920.
   ⚠️ T-5 må IKKE have rabat, ellers fejler assertionen (linjesum er før rabat). Bekræft T5.discount=0.
2. **Kunde-resolver:** firma vinder over privat; begge tomme → `null`.
3. **Rabat → discountPercentage** sættes pr. linje når `offer_discount_percent>0`, udelades ved 0.
4. **Levering (synt. linje):** når `bon.delivery_price>0` OG ingen x-Levering-linje → køretøj-varenr
   (fallback 17). `delivery_price=0` → ingen linje. Findes en x-Levering-linje → ingen synt. linje (ingen dobbelttælling).
5. **Miljøgebyr/service som recipe:** en `bon_line` med x-Levering/x-Service recipe (fx miljøgebyr)
   kommer med som normal linje med sit recipe-varenr (98) — ingen særbehandling.
6. **Tilbehør med:** `is_accessory=1`-linjer er med i payloaden (modsat `line_total`).
7. **special_request** indlejres i `description`.
8. **date = i dag**, `delivery.deliveryDate = bon.delivery_date` (de er forskellige).
9. **Afrunding:** `unitNetPrice` har maks. 2 decimaler.
10. **Blokering:** manglende recipe-nr ELLER kunde-nr → kaster/422 med liste, ingen payload.

### Trigger-test (mod in-memory DB, som contact_points-triggerne testes)
11. INSERT bon for firma med `discount_percent=12.5` + `offer_discount_percent=0` → seedes til 12.5.
12. INSERT bon med eksplicit `offer_discount_percent=5` → forbliver 5 (eksplicit vinder).
13. INSERT bon for kunde uden rabat → forbliver 0.
14. Firma-rabat vinder over kunde-rabat (begge sat).
15. Senere UPDATE af firmaets `discount_percent` rører IKKE eksisterende bon (snapshot).
16. Produktions-bon uden customer/company (events.js) → 0, ingen fejl.

### Integration (spawned server, isoleret test-DB, mock e-conomic HTTP)
17. `POST /api/invoices/:bonId/economic-draft` happy path → gemmer `economic_draft_number`,
    broadcaster `bon_updated`, changelog-entry.
18. Re-send-guard: andet kald på samme bon → ingen nyt udkast.
19. Manglende kobling → 422 + liste, intet gemt.
20. Auth: uden session → 401.
21. EAN-kunde → blokeret med EAN-besked (når spor 3-detektion er på).

### Manuel e2e (mod e-conomic DEMO først, så ét rigtigt udkast)
22. Demo-tokens (`X-AppSecretToken: demo`): byg payload, POST draft, verificér felter i e-conomic UI:
    linjepriser ex moms, e-conomic-beregnet moms = 25 %, leveringsdato + -adresse, bon-nr i reference,
    rabat synlig. (Demo = kun GET reelt; brug til payload-validering + ét rigtigt udkast på RR-kontoen.)
23. Ét **rigtigt** udkast på en simpel intern test-bon → gennemse i e-conomic → slet udkastet igen.
    Bekræft at totalen matcher bonen (incl moms) inden for øre.

---

## TESTSTRATEGI FØR GO-LIVE — sikker live-test uden mockup

Den vigtige pointe: **et udkast i e-conomic gør INGENTING indtil et menneske bogfører det.**
Det betyder at integrationen er nærmest ufarlig at teste mod det rigtige Nordic Fast Food-regnskab
— ingen kunde ser noget, intet sendes, intet bogføres. Derfor behøver vi ikke en kompliceret mockup.

**To billige testniveauer, før noget overhovedet rammer e-conomic:**
1. **Dry-run / preview (ingen e-conomic-kald):** byg `buildDraftInvoice(bon)` og returnér payloaden
   som JSON i et preview-endpoint/UI uden at POST'e. Det er "mockup'en" — man ser præcis hvad der
   ville blive sendt (linjer ex moms, rabat, levering, referencer, totaler) for en hvilken som helst
   rigtig bon, helt uden side-effekter. Byg dette FØRST; det fanger 90 % af fejlene gratis.
2. **Pre-flight readiness:** kør readiness-tjekket (manglende recipe-/kunde-/kontaktnumre) mod de
   rigtige data, så vi ved hvad der ville blive blokeret — uden at sende noget.

**Live-test på branchen (det du foreslog — ja, det er vejen):**
- Push branchen → checkout på Hetzner → `sudo systemctl restart bon-v2` (standard deploy-flow,
  test FRA branch FØR merge). Kør mod **grocytest** + det **rigtige** e-conomic-regnskab.
- Opret udkast fra en **syntetisk test-bon** (prefix `T_ECON_`) → åbn udkastet i e-conomic →
  verificér felter mod referencefakturaen → **slet udkastet igen** i e-conomic.
- Reversibelt hele vejen: udkast slettes med `DELETE /invoices/drafts/{draftInvoiceNumber}` (eller i
  UI); nulstil bonens `economic_draft_number` for at gen-teste. Intet er bogført, intet er sendt.
- Verificér mindst: en normal erhvervs-bon, en rabat-bon (12,5 %), en bon med levering + miljøgebyr,
  en EAN-kunde (udkast oprettes; bogfør IKKE — eller bogfør ét bevidst og slet/kreditér bagefter
  hvis I vil se EAN-afsendelsen).
- **Merge først efter din godkendelse i drift** (jf. deploy-reglerne). Branchen overlever merge.

**Hvorfor ikke en mockup:** en fuld e-conomic-mock ville skulle efterligne moms-beregning, layout,
nummertildeling og bogføring — meget arbejde for ringe værdi, når ægte udkast er gratis og
reversible. Mock bruges kun i unit/integration-tests (hurtige, deterministiske); den ægte
verifikation sker mod rigtige udkast vi sletter.

---

## UDFORDRINGER / RISICI (det jeg ser nu)

1. **Kø-workflow (vigtigst).** Uden et "udkast oprettet"-spor ender bons i en gen-send-løkke →
   dublet-udkast. Løst af `economic_draft_number`-feltet + guard ovenfor — men beslutningen
   besluttet: overstregning i køen + bonen bliver til den faktureres (se workflow-sektionen).
2. **`sellable=1`-fælden.** `getRecipes()` skjuler ude-af-sæson-recipes; economic-nummeret SKAL
   slås op fra de rå recipes, ellers fejler forsinkede fakturaer. Indbygget i plan (punkt 3).
3. **vatZone hardcoded = 1.** EU/eksport-kunder ville få forkert momszone. Fase 1 antager DK
   (indenlandsk) — inkl. EAN/offentlige, der også er indenlandske (vatZone 1). EU/eksport
   håndteres separat hvis det bliver relevant.
4. **Øre-drift.** Sum af afrundede ex-moms-linjer × 1,25 rammer ikke altid `total_price` på øren.
   Besluttet: e-conomics total er sandhed; preview viser e-conomics tal. Test 23 verificerer inden for øre.
5. **Kontaktpersoner skal have eget e-conomic-nummer.** "att."-personen bor som kontakt under
   firmaet i e-conomic (`customers.economic_contact_id`). For EAN-kunder er en kontaktperson
   PÅKRÆVET (ellers fejler bogføring). → kontakt-numre skal med i opret-/kobl-flowet (samme
   dokument/API-vej som kunder, jf. ADAPTER fejlhåndtering B).
6. **Idempotency-vindue = 1 time** hos e-conomic. Kombineret med `economic_draft_number`-guarden
   er dublet-risikoen dækket både kortvarigt (key) og varigt (felt).
7. **Backfill-disciplin.** Adapteren læser kun det færdige Grocy-userfield. Hvis backfill er
   ufuldstændig, blokeres fakturaer (by design) — men det kan ramme mange bons på én gang ved
   go-live. Anbefaling: kør en rapport "recipes solgt seneste 90 dage uden economic_product_number"
   FØR go-live, så backlog ryddes på forhånd.
8. **Standing-rabat backfill.** Triggeren rammer kun NYE bons. Besluttet: INGEN tilbagevirkende
   kraft — eksisterende ufakturerede bons for frokostportal-kunden får ikke rabatten automatisk.
   (Hvis en gammel bon skal have rabatten, sættes den manuelt på bonen.)

---

## FORBEDRINGSFORSLAG

- **Preview før send.** Genbrug visnings-disciplinen (ADAPTER) til en lille "Sådan ser udkastet ud"
  i fakturering (linjer ex moms + kundetotal incl moms) FØR POST — fanger manglende numre/forkert
  rabat før det rammer e-conomic.
- **Pre-flight rapport** (punkt 7) som genbrugeligt endpoint: `GET /api/invoices/economic-readiness`
  → liste over bons i køen der vil blive blokeret + hvorfor. Gør go-live forudsigeligt.
- **Settings-UI** for de 4 economic-nøgler (admin) i Settings → Integrationer, så de ikke kun
  kan sættes via SQL — konsistent med resten af appen.
- **Genbrug `createBon()`-triggeren som mønster** når issue #237 bygges; den stående rabat kan
  da flyttes til applikationslaget med triggeren som sikkerhedsnet (ingen ændring nødvendig nu).

---

## AFKLARET (25. juni 2026)

- **Workflow:** overstregning, ikke ny status. Leverede ikke-kontant-bons bliver i
  "Afventer fakturering" og vises **overstreget når udkast er sendt** (samme look som
  fakturerede). De bliver i køen indtil de faktisk faktureres → flytter så til "Faktureret".
  Udkast giver kun overstregning + re-send-guard. ✅
- **Pre-flight:** JA — byg readiness-tjek der lister bons/varer uden e-conomic-nummer FØR go-live. ✅
- **Tæller (Leifs idé):** fakturerings-striben får et "Kladder venter · N"-kort. ✅
- **Link til e-conomic:** VALGFRIT. Et per-kladde deep-link findes muligvis ikke (SPA-UI) — derfor
  vises altid kladde-nummeret, og linket er en valgfri bekvemmelighed (per-kladde hvis muligt,
  ellers generelt kladde-liste-link, ellers intet). Ingen funktionalitet afhænger af det. ✅
- **Rabat-backfill:** INGEN tilbagevirkende kraft. Triggeren rammer kun nye bons; eksisterende
  ufakturerede bons for rabat-kunden får ikke rabatten automatisk. ✅
- **Miljøbidrag:** findes som **Grocy-produkt** (29 kr, x-Levering) — håndteres som en almindelig
  `bon_line`, ikke et bon-felt. Det `bon.miljobidrag`-felt findes ikke og er fjernet fra spec'en.
  **Bidrag pålægges moms** (afgifter gør ikke) → varenr 98 i e-conomic skal have momspligtig
  momskode. Bemærk skellet i Grocy: "Rabat" (momspligtig) vs. "Rabat - afgift -" (afgift, momsfri). ✅
- **Følge-konsekvens:** levering/service/gebyr er Grocy-recipes → normale linjer. Eneste særtilfælde
  er det nye logistik-systems `bon.delivery_price` (uden linje), der syntetiseres fra køretøjets varenr.

### Bekræftet 25. juni (dine svar + API-tjek)
- **Payload-format verificeret mod e-conomic REST API:** `discountPercentage` (0–100) er rigtigt
  linje-felt; `references.salesPerson`/`customerContact`/`other` findes; number-shortcuts er gyldige.
  (Levering inline `delivery` vs `deliveryLocation` bekræftes mod live-skema ved build.)
- **Manglende recipe-nummer:** gør opmærksom + guid til oprettelse. 3 veje: opret rigtig vare /
  auto-opret via `POST /products` (valgfri) / **engangs-produktnummer + overskriv tekst+beløb** for
  ægte engangsvarer (`economic_oneoff_product_number` i settings).
- **Nye kunder:** kommer ofte → dokument/clipboard-flow (som taxa-booking) → opret manuelt i
  e-conomic → tast nummer tilbage. (API-oprettelse `POST /customers` som senere forbedring.)
- **Kontaktpersoner:** bor under firmaet i e-conomic og skal også have et e-conomic-nummer
  (`economic_contact_id`). Påkrævet for EAN-kunder.
- **e-conomic-numre er stabile**, men nye recipes opstår løbende → backfill engangs + vedligehold.
- **Vi sender ALDRIG moms selv** — e-conomic regner ud fra varens momskode + kundens momszone.
- **Kun nye bons faktureres.** ✅
- **Konverteret tilbud → bon beholder `offer_discount_percent`.** ✅ (rabat bevares)
- **En bon har ALDRIG både `delivery_price` OG en x-Levering-linje.** ✅ (ingen dobbelttælling —
  synteselinje-guarden er dermed bælte+seler, ikke strengt nødvendig.)
- **T-5 testbon har INGEN rabat.** ✅ (moms-test #7's ex-moms-linjesum-assertion holder.)
- **EAN er VIGTIGT (stor kundeandel)** og håndteres uden separat kanal: e-conomic sender EAN ved
  bogføring (CVR ✅ + EAN + kontaktperson på kunden). Rekvisition leveres af kunden når påkrævet.
- **Betalingsbetingelse:** BESLUTTET — send ALTID default `paymentTermsNumber: 1` (Netto 8 dage).
  Alle kunder er Netto 8 i dag, og betingelsen printes på fakturaen af layoutet (bekræftet på
  referencefakturaen). Afvigende vilkår = undtagelse for den ene kunde senere. ✅
- **Email-idé (Leif):** læg et link til RR's betalingsbetingelser i bekræftelsesmailen kunden får.
  Kræver INGEN kode — tilføj linket i `booking_confirmation`-skabelonen via Settings → Mail. ✅

---

## TO TING FORKLARET — nu BESLUTTET (begge: anbefalingen valgt)

### "Workflow: overstregning vs. separat status?" → **A (overstregning) valgt**
Når vi sender en faktura til e-conomic, laver vi kun et **udkast** — et menneske skal stadig
godkende/bogføre det inde i e-conomic. Spørgsmålet er: **hvordan ser Bon v2 ud i mellemtiden?**

I dag har fakturerings-listen bons der venter (LEVERET + skal faktureres). To måder at vise
"udkast er sendt, venter på din godkendelse i e-conomic":

- **A (valgt): overstreget i køen.** Bonen bliver i "Afventer fakturering", men vises
  **overstreget** (samme look som de fakturerede bons i listen) når udkastet er sendt. Når du
  har bogført inde i e-conomic, klikker du den eksisterende "Markér faktureret"-knap, og bonen
  flytter til "Faktureret". Simpelt, rører ikke status-systemet.
- **B: en helt ny status** (fx "FAKTURA_UDKAST") som bonen skifter til. Mere "rigtigt", men
  kræver ændringer i status-flowet flere steder.

**Valgt: A.** Sendt udkast = overstreget i Afventer-køen; bonen bliver der indtil den faktisk
faktureres (giver overblik). Det undgår samtidig at samme bon sendes to gange og laver to udkast.

### "Pre-flight backlog-oprydning?" → **JA valgt**
For at en faktura kan sendes, skal **hver vare på bonen have et e-conomic-nummer** (det tal i
"Nr."-kolonnen). De numre taster I ind i Grocy på hver recipe. Hvis en vare mangler sit nummer,
kan dens bon ikke faktureres (den blokeres — med vilje).

Risikoen: på dagen vi går live kan der ligge mange bons og vente, og hvis flere varer mangler
numre, bliver en stribe fakturaer blokeret på én gang — irriterende overraskelse.

**Pre-flight = en liste på forhånd:** "disse solgte varer (seneste ~90 dage) mangler et
e-conomic-nummer i Grocy" — så I kan taste dem ind FØR go-live i stedet for at opdage det
midt i en faktureringsdag.

**Du skal bare svare:** skal jeg planlægge sådan en tjek-liste (ja/nej)? (Jeg anbefaler ja.)
