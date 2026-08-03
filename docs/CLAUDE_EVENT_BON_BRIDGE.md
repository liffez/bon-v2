# CLAUDE_EVENT_BON_BRIDGE.md — Bro mellem event-forudbestilling og Bon v2

> **Status:** Design-/handoff-dokument (ikke bygget). Skrevet ved afslutning af en
> lang session hvor `event-order-3` blev væsentligt forbedret. Fanger visionen +
> arkitekturen mens konteksten var frisk, så en NY session kan bygge broen uden at
> genopdage det hele.
>
> **To repos i spil:**
> - **`event-order-3`** (separat app): forudbestilling til mad-events. Kunder bestiller
>   + betaler via Stripe, multi-leverandør, realtids pickup/køkken. Node + Express +
>   socket.io + **sql.js** (egen DB, IKKE Bon v2's). Ligger i `~/Documents/Projekter/event-order-3`.
> - **`bon-v2`** (dette repo): produktion, køkken, Grocy, e-conomic, cashflow, event-modul.

---

## 1. Vision

To dele:

1. **Menu fra Grocy** — i stedet for at vedligeholde menuen i `event-config.json` skal
   (kun) Ristet Rug's menu trækkes fra Grocy (via Bon v2), så der er én menu-kilde.
2. **Bon pr. event-dag i Bon v2** — de gennemførte forudbestillinger for en given dag
   aggregeres til **én ren produktions-bon** i Bon v2, så køkken/produktion/regnskab ser
   efterspørgslen. Ikke pr.-kunde — bare "lav X af hver ret til denne dag".
3. **QR i bekræftelsen** — så kunden let kan skannes ved afhentning.

---

## 2. Beslutninger (afklaret med Leif — byg efter disse)

| # | Beslutning |
|---|-----------|
| 1 | **Broen bor i Bon v2.** event-order-3 pusher gennemførte ordrer til et Bon v2-endpoint (samme mønster som den eksisterende web-order-webhook). |
| 2 | **INGEN under-reference på bonnen.** Bonnen skal være ren og enkel og bare vise hvad der skal være klart (produktion). event-order-3 ejer kunde-matchingen ved udlevering (pas/QR). Bon v2 ser ALDRIG individuelle kunder — kun aggregatet. |
| 3 | **Grocy-menu KUN for Ristet Rug.** Øvrige leverandører bruger fortsat `event-config.json` (JSON). Integrationen er pr.-leverandør og valgfri. |
| 4 | **event-order-3 forbliver en SEPARAT app** — så andre også kan bruge den. Bon v2-koblingen er en opt-in-integration pr. leverandør, ikke en sammensmeltning. |

**Konsekvens af #2 + #4:** ren ansvarsdeling —
- **Bon v2** = produktion + økonomi (aggregeret pr. dag).
- **event-order-3** = kundevendt + udlevering (individuelt, med pas/QR).

Den tidligere idé om et sub-nummer (`#b4321-0027`) er altså **droppet** — bonnen holdes ren.
QR'en peger på event-appens eget afhentningspas (se §5), ikke på en Bon v2-reference.

---

## 3. Arkitektur (anbefalet)

```
event-order-3 (Ristet Rug-vendor, opt-in)
  │
  │  A) Menu:  GET  bon-v2/<event-menu-endpoint>   ← Grocy-sourced menu (kun Ristet Rug)
  │
  │  B) Ordrer: når dagens bestillinger er klar (cutoff/batch), POST aggregat →
  │            bon-v2/<event-bon-endpoint>  { event, dato, linjer:[{grocy_recipe_id, antal}] }
  ▼
bon-v2
  - opretter/opdaterer ÉN produktions-bon pr. event-dag (event-modulet, prep-rolle)
  - linjer = "lav N af hver ret" (rene produktions-tal, ingen kunder)
  - Grocy-consume, e-conomic, cashflow følger med gratis

event-order-3 (uændret for kundevendt del)
  - pas-side + QR + scan-til-udleveret  ← ejer kunde↔menu-matchingen
```

**Pr.-leverandør-flag i event-config.json** (nyt, kun sat på Ristet Rug), fx:
```json
{ "id": "ristet-rug", "name": "Ristet Rug",
  "bonV2": { "enabled": true, "menuFromGrocy": true } }
```
Andre vendors har ikke `bonV2` → uændret (JSON-menu, ingen bon-sync).

---

## 4. Eksisterende brikker at genbruge (så I ikke bygger fra bunden)

### I Bon v2
- **Web-order-webhook** — `routes/web-orders.js` `POST /webhook/bestilling` + `createBon()` i
  `db/helpers.js`. Broens bon-oprettelses-endpoint kan bygge på samme mønster (public,
  CORS, `createBon`). Se også `docs/formbuilder/CLAUDE_PREORDER_ASIS.md`.
- **Grocy-menu** — `routes/embed.js` `buildMenuFromGrocy()` + `bestilling.menu_source`-setting.
  Kan genbruges/parametriseres til event-menu-endpointet for Ristet Rug.
- **Event-modulet** — `routes/events.js` + `office/views/events.js`. Har ALLEREDE
  "ét event → flere bons" med `event_role` (prep/topup/sales/expense), `event_forecast`,
  event-menu (`event_menu_items`, migration 131) og en generator. **Dagens produktions-bon
  passer direkte som en `prep`-bon under et event.** Bemærk: event-salgsbons trækker ikke
  HQ-lager (kun prep-bons) — se "No-deduct gate §5" i CLAUDE.md's event-sektion.
- **Bon-numre** — `nextBonNumber` i `db/helpers.js`, `bon_number_prefix` (`B`). Bon v2 ejer
  nummereringen. (Ingen sub-numre — jf. beslutning #2.)
- **Menu_items → bon-linjer** — PR #383 (`services/menuItemsToLines.js`): oversætter
  `[{id,count}]` + Grocy-opskrift → prissatte bon-linjer. Samme idé kan bruges når
  event-aggregatet (grocy_recipe_id + antal) skal blive til produktions-linjer.
- **Priser/moms** — festival-priskategori bruges til event-salg (memory
  `project_event_festival_pricing`); alt via `shared/moms.js` (aldrig magic `* 1.25`).

### I event-order-3
- **`Docs/FEATURE-ordernumber-mail-qr-pass.md`** — komplet (men UBYGGET) spec for ordrenummer
  + bekræftelsesmail + **afhentningspas (/pass/:orderId) med QR** + scan-til-udleveret.
  **Vigtig indsigt derfra:** proppe IKKE en QR ind i Stripes egen kvitteringsmail (kan ikke
  tilpasses med billeder) — mailen LINKER til en pas-side der renderer QR'en. Det er den
  rigtige vej og den kundevendte QR-del bor HER, ikke i Bon v2.
- **`handleCompletedOrder`** i `server.js` — Stripe-webhook der gemmer ordren. Naturligt sted
  at tilføje bon-v2-push (for Ristet Rug-vendor), fire-and-forget, efter DB-gem.
- **Menu-modellen** — `allMenuItems(config)` flader vendor-menuer. For Ristet Rug byttes
  kilden til Grocy (via bon-v2), for andre bevares `config.vendors[].menu`.
- **CLAUDE.md** (event-order-3) — autoritativt arkitektur-dokument for den app.

---

## 5. QR-flow (fra event-order-3's FEATURE-doc — bor i event-appen)

1. Ordre gennemføres → event-order-3 gemmer + tildeler ordrenummer (fx `RR-047`).
2. Bekræftelse (Stripe-kvittering for betalt; egen mail for faktura) linker til
   **pas-siden** `/pass/:orderId`.
3. Pas-siden renderer QR (indkoder det opake `orderId`, ikke et pænt/sekventielt nummer).
4. Ved afhentning: personalet scanner QR i pickup → `order:deliverAll` → udleveret.

Bon v2 er **ikke** involveret i denne del — den ser kun dagens aggregat (§3B).

---

## 6. Foreslåede faser (til den nye session)

1. **Bon v2: event-menu-endpoint** (Grocy-sourced, kun til Ristet Rug-brug). Genbrug
   `buildMenuFromGrocy`. Afklar auth (public som embed, eller nøgle).
2. **event-order-3: Grocy-menu pr. vendor.** `bonV2.menuFromGrocy`-flag → hent menu fra
   Bon v2 i stedet for JSON (kun Ristet Rug). Bevar JSON-vejen for andre.
3. **Bon v2: event-bon-endpoint.** Modtag `{event, dato, linjer:[{grocy_recipe_id, antal}]}`
   → opret/opdatér ÉN prep-bon pr. event-dag under et event (event-modulet). Idempotent
   (samme dag → opdatér, ikke dublér).
4. **event-order-3: push aggregat.** Beslut trigger: **batch ved cutoff** (renest — én bon
   med endelige tal pr. dag) vs. **realtid** (live tal, opdaterer bonnen løbende). Kun for
   Ristet Rug-vendor.
5. **QR/pas** (event-order-3): byg FEATURE-doc'et (ordrenummer + mail-link + pas-side + scan).
   Uafhængigt af broen — kan bygges parallelt.

---

## 7. Åbne spørgsmål

- **Aggregerings-trigger** (fase 4): batch-ved-cutoff vs. realtid. Anbefaling: batch — én
  ren bon pr. dag med endelige tal; enklere og matcher "bon for de enkelte dage".
- **Event↔dag-model:** ét event i Bon v2 med én prep-bon pr. dag, eller ét event pr. dag?
  Bon v2's event-modul understøtter flere bons pr. event → én prep-bon pr. dag under ét
  event er den naturlige model.
- **Auth mellem apps:** delt hemmelighed/nøgle på bon-endpointet (event-appen kører på et
  andet domæne). Web-order-webhooken har allerede et `webhook_secret`-mønster.
- **Menu-mapping:** event-order-3's item-id'er skal bære `grocy_recipe_id` for Ristet Rug
  (så aggregatet kan pege på Grocy-opskrifter). Bon v2's `menuItemsToLines` bruger `r<id>`.
- **Multi-tenant (beslutning #4):** hvis andre kunder skal bruge event-order-3, skal
  bon-v2-koblingen være konfigurerbar (endpoint-URL + nøgle pr. installation), ikke hardkodet
  til Ristet Rugs Bon v2.

---

## 8. Hvad denne app IKKE skal (for at holde snittet rent)

- Bon v2 ser aldrig individuelle event-kunder (ingen PII, ingen sub-numre) — kun aggregat.
- event-order-3 forbliver standalone og sælgbar til andre; bon-v2-broen er opt-in pr. vendor.
- QR/pas/udlevering bor i event-order-3, ikke i Bon v2.

---

*Skrevet som handoff ved sessionens afslutning. Start den nye session med:*
*"byg event↔bon-v2-broen — se docs/CLAUDE_EVENT_BON_BRIDGE.md".*
