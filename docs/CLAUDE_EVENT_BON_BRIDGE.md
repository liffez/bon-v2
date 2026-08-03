# CLAUDE_EVENT_BON_BRIDGE.md — Bro mellem event-forudbestilling og Bon v2

> **Status:** BYGGET (Fase 1–4 + live smoke, 3. aug 2026). Kode + tests landet på
> begge sider; mangler kun deploy-config (§0.3) før den er live. Afsnit §1–§8 nedenfor
> er det oprindelige design — det holdt ved implementeringen og bevares som reference.
>
> **To repos i spil:**
> - **`event-order-3`** (separat app): forudbestilling til mad-events. Kunder bestiller
>   + betaler via Stripe, multi-leverandør, realtids pickup/køkken. Node + Express +
>   socket.io + **sql.js** (egen DB, IKKE Bon v2's). Ligger i `~/Documents/Projekter/event-order-3`.
> - **`bon-v2`** (dette repo): produktion, køkken, Grocy, e-conomic, cashflow, event-modul.

---

## 0. Status: BYGGET — hvad, hvor, test, deploy

Broen laver **kun prep-bon** (ren produktion). Salget kører via cashflow-flowet på den
ægte daglige Stripe-bankudbetaling (§2.E i `CLAUDE_PENGESTROEM.md`) — så omsætningen
tælles aldrig to gange. Alt defaulter til **slukket** indtil deploy-config (§0.3) er sat.

### 0.1 Filer

**bon-v2 (modtager-ende):**
- `routes/event-bridge.js` — public router (monteret på `/webhook` i `server.js`, uden
  for auth-gaten, med optionel delt secret `settings.event_bridge_secret`):
  - `GET /webhook/event-menu?menu=standard` — Ristet Rugs Grocy-menu i event-order-3-format
    (`id:'r<id>'`, navn, kategori, **festival-pris i øre** (incl moms), tags, allergener).
    Genbruger samme kategori/skjul/tags-logik som `routes/embed.js`.
  - `POST /webhook/event-prep` — body `{ event_id, date, lines:[{grocy_recipe_id, antal}] }`.
    Find-eller-opret **prep-bon** for `(event_id, delivery_date, event_role='prep')`:
    ingen → opret (produktion, GODKENDT, linjer via `resolveMenuItemLines`);
    findes + status NY/GODKENDT → **reconcile** (slet linjer, genindsæt — fuld-erstat);
    findes + status ≥ IGANG **eller** `inventory_deducted=1` → **frys** (`action:'frozen'`).
    Idempotent. Kernen er eksporteret (`applyPrepPush`, `resolvePrepLines`) til test.
- `scripts/test-event-bridge-menu.js` (21) · `scripts/test-event-bridge-prep.js` (30) ·
  `scripts/test-event-bridge-live.js` (19, HTTP mod grocytest, isoleret temp-DB).

**event-order-3 (afsender-ende):**
- `bonV2Bridge.js` — al bro-logik samlet ét sted (deps injiceres → testbar isoleret):
  `refreshGrocyMenus`/`vendorMenu` (Fase 2: overlejr Grocy-menuen på vendorens JSON-menu,
  falder tilbage til JSON hvis Bon v2 er nede), `slotDateMap`/`buildPrepPayloads`/`pushPrep`
  (Fase 4: aggreger ordrer pr. pickup-dato → push per-dag). Secret fra `process.env.BON_V2_SECRET`.
- `server.js` — wirer `bonV2.vendorMenu` ind i `allMenuItems`/`vendorMenuItems`/`/api/event`,
  starter menu-refresh (opstart + hver 10. min), og pusher aggregatet i `handleCompletedOrder`
  efter `saveOrder` (fire-and-forget, ved siden af den eksisterende Sheets-webhook).
- `event-config.json` — `bonV2`-blok på `ristet-rug`-vendoren (default `enabled:false`).
- `test-bonV2-bridge.js` (29 unit) · `test-grocy-live.js` (5 — live-smoke af Grocy-menu-
  integrationen mod en kørende bon-v2: `BON_V2_DIR=… node --experimental-sqlite test-grocy-live.js`;
  skipper rent uden `BON_V2_DIR`).

**104 grønne asserts i alt** (bon-v2: 21 menu + 30 prep + 19 live · event-order-3: 29 unit + 5 Grocy-live).

### 0.2 Nøgle-mekanismer (holdt ved implementeringen)
- **Multi-dag falder ud gratis** på bon-v2-siden: prep-bonnen nøgles på `delivery_date`,
  så 2 dage → 2 prep-bons under ét event. På event-order-3-siden bestemmes dagen af
  **pickup-slottets `date`** (valgfrit felt pr. slot; mangler det → event-datoen).
  Derfor virker "bestillinger på dag 1 til dag 2" — ordren følger slottets dato, ikke
  bestillingstidspunktet.
- **Frys = pr. bon-status, ikke deadline.** Hver dags prep-bon opdaterer sig selv indtil
  netop den dags produktion går i gang (IGANG) eller lageret er trukket — så én fælles
  deadline er nok.
- **Fuld-erstat reconcile** → event-order-3 pusher HELE dagens aggregat ved hver ordre
  (ikke kun den nye linje), ellers ville bonnen blive nulstillet til én ordre.
- **Ingen Grocy-id på JSON-menuen** ⇒ uden `menuFromGrocy` kan der ikke laves prep-bon
  (varianter mangler Grocy-kobling); den vendor bruger event-appens egen produktionsfane.
  Grocy-varianter (brødvalg/glutenfri) kollapser til basis-opskriften på prep-bonnen.

### 0.3 Deploy-checkliste (før live)
1. **bon-v2:** sæt `settings.event_bridge_secret` (valgfri, men anbefalet — håndhæves kun hvis sat).
2. **event-order-3 `.env`:** `BON_V2_SECRET` = samme værdi.
3. **Opret eventet i bon-v2 først** → kopiér dets `event_id` til `ristet-rug.bonV2.eventId`
   i `event-config.json`, og sæt `enabled + menuFromGrocy: true`.
4. **Multi-dag:** giv pickup-slots et `date`-felt (YYYY-MM-DD) pr. dag; ellers falder alt
   til event-datoen (enkelt dag).
5. **CORS:** server-til-server-push sender ingen Origin, så `webhookCors` blokerer ikke —
   ingen ekstra origin-opsætning nødvendig.
6. **Verificér før åbning:** kør Grocy live-smoken
   (`BON_V2_DIR=/sti/til/bon-v2 node --experimental-sqlite test-grocy-live.js`) — bekræfter
   at event-order-3 kan hente menuen fra bon-v2 (fetch + secret-gate + menu-overlay) mod ægte Grocy.

### 0.4 Link til event-order-3-admin (point 2) — BYGGET
Setting `event_order_admin_url` (migration 132) → "🔗 Event-ordre-admin"-knap i office
event-detaljens header (`office/views/events.js`), vises kun når URL'en er sat (kun
`http(s)`, åbner ny fane). Sæt URL'en i **Settings → System**. Bevidst kun et **link**,
ikke auto-provisionering — event-order-3 er enkelt-config, så "opret event-ordre" = "åbn admin'en".

### 0.5 Bevidst ikke bygget
- **QR/pas/udlevering** (§5) — event-order-3's egen FEATURE-doc, uafhængigt af broen.
- **Salgsbon fra broen** — bevidst fravalgt (§0 + point 3): salget kører via cashflow.

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
