# Indkøbsmodulet — sådan fungerer det NU (as-is)

> Formål: dette dokument beskriver **den nuværende faktiske tilstand** af indkøbsmodulet,
> grounded i koden (juli 2026), som grundlag for en restrukturering.
> Det beskriver IKKE hvordan det *bør* være — kun hvordan det er.
> Skrevet så det kan læses koldt af en der ikke kender kodebasen (fx claude.ai).
>
> Modulet er vokset organisk gennem faserne 6a → 6b → 6c → 6d → 6e → 6f → 6g → 6h →
> 6h-revision (se `CLAUDE.md`). Hver runde løste et konkret driftsproblem, men helheden
> er aldrig tegnet om. Det viser sig som overlap, dobbelt-navngivning og undtagelser der
> ikke passer ind i grundmodellen.

---

## 1. Grundmodel: tre kilder til sandhed

Modulet har bevidst **tre** steder data bor. At forstå denne opdeling er nøglen til alt andet.

| Kilde | Ejer | Indhold |
|-------|------|---------|
| **Grocy** | ekstern | Selve indkøbslisten (`shopping_list`), produkter, lager, barcodes, enheds-konverteringer |
| **Bon-DB (SQLite)** | os | Leverandør-metadata, leverandør↔Grocy-kobling, afsendte bestillinger (`purchase_orders`), mail-tråde |
| **Hørkram (hoka.dk)** | ekstern | Live priser, CO₂, aftale-status, salgsenheder, selve kurven. Hentes on-demand, persisteres ikke |

**Konsekvens:** en enkelt vare på indkøbslisten samler data fra alle tre. Behovet kommer fra
Grocy (`shopping_list`-linje), leverandør-kandidaterne kommer fra Grocy `product_barcodes`
+ Bon-DB's leverandør-kobling, og pris/CO₂/udgået-status kommer live fra Hørkram. Der er
ingen ét-sted-overblik — billedet samles først i browseren.

### To døde/ubrugte spor (rydder op i forvirringen)
- **`services/hokaAdapter.js` er død kode.** Den er ikke koblet til nogen route. Den aktive
  Hørkram-integration er den selvstændige `routes/horkram.js`. Adapteren indeholder bl.a. en
  `submitOrder()` + dropsize-tjek der *aldrig kaldes* — hvilket kan forlede en til at tro at
  systemet selv afgiver ordrer. Det gør det ikke (se §5).
- **Bon-DB's lokale `shopping_list`-tabel bruges ikke.** Den findes (migration 005) og har en
  FK, men `orders.js` indsætter eksplicit `null` i den. Indkøbslisten bor 100 % i Grocy.

---

## 2. Hvor bor tingene i UI'et — og hvorfor det forvirrer

Der er **to forskellige shells** med **forskellige tab-sæt**. Det er den primære kilde til
"hvad er forskellen på Indkøbsliste og Bestillinger?".

### A) Køkken-shell — `kitchen/purchasing.html`
Kun **3 top-tabs:**

| Tab | Mounter |
|-----|---------|
| **Indkøb** | `initIndkob()` — hele indkøbslisten OG bestillingen i én komponent |
| **Varemodtagelse** | `initVaremodtagelse()` |
| **Post** | `initSupplierInbox()` (leverandørpost) |

Her findes **ingen** separat "Bestillinger"- eller "Forecast"-tab. Hele indkøb-plus-bestilling
lever inde i den ene `initIndkob`-komponent. Et tandhjul åbner indstillingerne som slide-in-panel.

### B) Office-shell — `office/index.html`
Sidebar-punktet "Indkøb" har **5 pills:**

| Pill | Internt view | Mounter |
|------|--------------|---------|
| **Indkøbsliste** | `indkob-liste` | `initIndkob()` |
| **Bestillinger** | `indkob-liste` | `initIndkob()` — **SAMME komponent, samme view** |
| **Forecast** | `indkob-forecast` | `initForecast()` |
| **Leverandører** | `indkob-lev` | `initIndkobSettings({mode:'page'})` |
| **Leverandørpost** | `leverandorpost` | `initSupplierInbox()` |

> ⚠️ **Kernefund:** "Indkøbsliste" og "Bestillinger" i office er **ikke to ting**. Begge pills
> mounter den *samme* `initIndkob`-instans med det *samme* interne view. Forskellen brugeren
> forventer (én liste = "hvad skal jeg købe", én = "hvad HAR jeg bestilt") findes ikke som to
> views. Det er samme skærm to gange.
>
> "Hvad har jeg bestilt" findes i stedet som en **kollapset sektion nederst i hver
> leverandørgruppe** ("Bestilt"-badge + dato), styret af `_ibShowOrdered`. Det er ikke et
> selvstændigt sted — og det er derfor det er svært at finde.

---

## 3. Views/tilstande inde i indkob.js

Komponenten har **to uafhængige akser** af visning (plus en masse mindre UI-flags):

### Akse 1 — gruppering: "Efter kategori" vs "Efter leverandør"
- **Efter kategori** (`_ibViewMode='combined'`): flad liste af ikke-bestilte varer, grupperet
  efter Grocy produktkategori. Alle varer, uanset leverandør.
- **Efter leverandør** (`_ibViewMode='order'`): leverandørgrupper (Convifood, Hørkram, RR
  Produktion, …), sorteret efter integration-type.
- Persisteres i localStorage (`ib_view_mode`).

### Akse 2 — kun i leverandør-mode: Liste vs Fokus
- **Liste**: alle leverandørgrupper på én gang.
- **Fokus**: kun én valgt gruppe ad gangen.

**Vigtigt:** begge akser viser *den samme underliggende liste* (Grocys `shopping_list`). Det er
grupperinger/filtre — ikke forskellige datasæt. Det er resultatet af 6h-revisionen, hvor et
tidligere "to-view-split" bevidst blev slået sammen til én handlingsbar liste.

---

## 4. Datamodel i detaljer

### Grocy `shopping_list`-linje
Det er selve "jeg mangler X". Userfields skrevet af os oveni:

| Userfield | Betydning | Sat hvornår |
|-----------|-----------|-------------|
| `ordered_at` | ISO-timestamp | Ved bestilling. **En vare regnes som "bestilt" når dette er sat.** Ryddes ved fortryd |
| `ordered_qty` | Bestilt antal | Ved bestilling |
| `ordered_supplier` | Leverandørens navn | Ved bestilling |
| `ordered_varenr` | Valgt barcode/varenummer | Ved bestilling |

### Grocy `product_barcodes` (= leverandør-kandidater = "chips")
Hver barcode er ét leverandør-tilbud på et produkt. Native felter: `barcode` (=
leverandør-varenummer), `product_id`, `last_price`, `note`, `shopping_location_id`. Userfields:

| Userfield | Betydning |
|-----------|-----------|
| `is_preferred` | Foretrukken leverandør (`'1'`) — sorteres allerøverst |
| `is_agreement_item` | Aftalevare (`'1'`) — sorteres over billigste |
| `supplier_unit_code` | Hørkram salgsenhedskode (`'ks'`, `'st'`) |
| `supplier_unit_qty` | Antal base-enheder pr. salgsenhed |
| `pack_size_stock_unit` | Pakkestørrelse i lager-enhed (til dæknings-beregning) |

Koblingen barcode → leverandør går via `shopping_location_id` → `supplier_grocy_locations` → `suppliers`.

### Bon-DB
- **`suppliers`** — `integration_type` (api/webshop/email/manual/intern), `contact_email`,
  `webshop_url`, `api_config_json`.
- **`supplier_grocy_locations`** — kobler én Grocy shopping_location → én leverandør
  (`UNIQUE(grocy_location_id)`). En leverandør kan have flere locations (fx Inco Valby + Frederiksberg).
- **`purchase_orders` + `purchase_order_lines`** — afsendte bestillinger. Status hårdkodes til
  `'sent'` ved oprettelse.

---

## 5. Flowet — fra behov til bestilling

```
Grocy shopping_list   →   _ibBuildGroups   →   leverandør-/kategori-visning   →   chips pr. vare
   (behovet)               (gruppér)              (§2/§3)                         (§4)
                                                                                     │
                                                    "Læg i kurv" / "Marker valgt"    ▼
                                                                              staging (bund-bar)
                                                                                     │
                                          ┌──────────────────────────────────────────┤
                                          ▼ (api = Hørkram)          ▼ (email/manual)  ▼ (intern)
                                  Hoka-kurv + PO oprettes    PO + evt. SMTP-mail   produktionsbon
                                          │                          │
                                  "Gå til kurv →"            "Send & bestil"
                                  åbner hoka.dk/checkout      via kontakt@
                                  i ny fane                        │
                                          └──────────┬─────────────┘
                                                     ▼
                                   ordered_* userfields sættes på shopping_list-linjer
                                          (= varen markeres "bestilt")
```

### Leverandørtyper og hvad de gør
| Type | Bestillingsflow |
|------|-----------------|
| **api** (Hørkram) | "Læg i kurv" → varer sendes til Hoka-kurven via API → "Gå til kurv →" åbner hoka.dk checkout i ny fane. **Vi afgiver ALDRIG ordren — brugeren godkender selv på hoka.dk.** |
| **email** | "Send & bestil" → opretter PO + sender ordremail via `kontakt@` (skabelon `order_email`) |
| **manual** | Kopiér liste / Ring (`tel:`) / bekræft manuelt |
| **webshop** | "Åbn webshop →" (`window.open`) — helt manuelt hos leverandøren |
| **intern** (RR Produktion) | "Opret produktionsbon" i stedet for indkøb |
| **none** (ukoblet vare) | "⚠ Kurv ikke klar" → skal kobles til en leverandør først |

### Kritisk: systemet afgiver ikke selv ordrer
For Hørkram lægger vi kun varer i kurven via API'et. Selve godkendelsen sker manuelt på
hoka.dk's checkout. Der er **ingen backend-`submitOrder`** i den aktive kode. Det betyder også
at leveringsdato, cutoff og minimumsbeløb (dropsize) i sidste ende håndhæves af Hoka — ikke af os.

---

## 6. Hørkram-integrationen

- Selvstændig proxy i `routes/horkram.js` (ikke `hokaAdapter.js`). Logger ind på hoka.dk med
  firmaets rigtige credentials, cacher session 30 min, re-logger automatisk ved 401/403.
- **Snapshots** (`/snapshots?ids=`): batch-henter live pris/CO₂/aftale-status/salgsenheder for op
  til 60 varenumre ad gangen (chunkes i 20). Alle kald bruger leveringsdato = **i morgen**, hårdkodet.
- **Kurv** (`PUT /basket/add`): Hoka erstatter HELE kurven ved hvert PUT, så vi henter eksisterende
  linjer og merger. Kræver anti-forgery-token. Håndterer at Hoka bruger `SalesUnitIndex` (ikke code).
- **Aftale-status** udledes af `SalesPriceSource.TrackingId === 'Fixed'` i snapshot-svaret.

---

## 7. Smertepunkterne — hvor grundmodellen knækker

Dette er kernen i hvorfor en restrukturering er nødvendig. De fire driftsproblemer brugeren
oplever peger alle på **samme rod**: modulet er optimeret til *fast genbestilling ud fra Grocys
minimumsgrænser*. Det knækker på undtagelserne.

### 7.1 Kan ikke nemt bestille ét bestemt varenummer i en bestemt mængde
**Oplevelse:** "jeg skal kun købe ét bundt af varenummer 60034742, men det kan jeg ikke tilføje."

**Rod:** der er ingen ren "smid denne præcise leverandør-vare + mængde i kurven"-vej. De to
tilføj-knapper gør noget andet:
- **"+ Tilføj vare"** søger *kun i eksisterende Grocy-produkter* (lokalt cache) — ikke i Hørkram-katalog.
- **"+ Opret/kobl"** er til at *koble et Hørkram-varenummer til et Grocy-produkt* (opret barcode),
  ikke til at bestille direkte.

Modellen forudsætter at alt går gennem "Grocy siger vi mangler → foreslå leverandør-vare". Et
rent engangskøb ("jeg vil bare have dette ene bundt") har ingen naturlig indgang.

### 7.2 Tilføjede varer fejler — leveringsdato + kurv-format
**Oplevelse:** "de varer jeg har tilføjet fejler — noget er fordi det er den forkerte dag; det
kan naturligvis ikke leveres samme dag som jeg bestiller."

**To adskilte problemer blandet sammen:**
1. **Leveringsdato:** der er *ingen* minimum-dag/cutoff-validering nogen steder — hverken frontend
   eller backend. `horkram.js` hårdkoder "i morgen" til pris-opslag, men der er ingen kontrol af om
   "i morgen" er en gyldig leveringsdag, og brugeren kan i checkout vælge en ugyldig dato. Hoka
   afviser den så — men først *efter* varerne er i kurven. Vi burde forhindre/advare før.
2. **"Produktet er tilføjet med fejl":** ligner kurv-format-buggen (mixed-format i `PUT /basket/add`)
   som skulle være fikset i fase 6e (Fix 3, `FIX_horkram_basket.md`). Kan være regression, eller
   at enkelt-vare/lille-mængde-tilfældet ikke er dækket. Skal reproduceres.

### 7.3 "Bestillinger" viser ikke hvad man har bestilt
**Oplevelse:** "hvad er forskellen på bestillinger og indkøbsliste — ved bestillinger burde man
gerne kunne se hvad man har bestilt."

**Rod (jf. §2):** i office er "Bestillinger" og "Indkøbsliste" *samme* komponent, samme view.
Der findes ikke et selvstændigt "det her har jeg bestilt"-overblik. Dataen findes
(`ordered_*`-userfields + `purchase_orders`-tabellen), men den er kun synlig som en kollapset
"Bestilt"-sektion i bunden af hver leverandørgruppe. Navngivningen lover noget UI'et ikke leverer.

### 7.4 Udgåede varer opdages for sent, og der er ingen erstatnings-flow
**Oplevelse:** "relativt mange produkter er udgået hos Hørkram; vi skal finde en smart måde at
finde erstatninger på — og på indkøbslisten kan man ikke se de er udgået før man går ind i
leverandøren og opdaterer priserne."

**Rod:**
- Udgået-status detekteres **kun** i Indstillinger → Hørkram → "Alle koblinger", via "Tjek udgåede"
  eller batch-prisopdatering. Signalet er svagt: en vare regnes som udgået hvis den *mangler* i
  snapshot-svaret (fravær = død). Der er intet eksplicit "udgået"-flag fra Hoka.
- Denne status vises **ikke på selve indkøbslisten**. Brugeren skal aktivt ind i indstillingerne
  og køre en opdatering for at opdage det.
- Der er **intet erstatnings-flow** overhovedet — ingen "find lignende vare" når noget er udgået.

### 7.5 Yderligere strukturelle observationer (fundet under kortlægningen)
- **Død kode forvirrer:** `hokaAdapter.js` (inkl. en `submitOrder` der antyder auto-bestilling)
  og Bon-DB's lokale `shopping_list`-tabel er begge ubrugte. De bør ryddes eller dokumenteres som døde.
- **To shells med forskellige tabs** (køkken 3-tab vs office 5-pill) betyder at "hvor gør jeg X"
  afhænger af hvor man står. Mental model er ikke ens på tværs af zoner.
- **Kilde-til-sandhed er spredt over tre systemer** uden ét samlende overblik — hver visning
  re-samler billedet i browseren, hvilket gør det svært at ræsonnere om "hvad er den sande tilstand".
- **Bestilt-status lever i Grocy-userfields, ikke i `purchase_orders`.** De to kan i princippet
  divergere (PO oprettet, men userfield ikke sat, eller omvendt). Der er ingen afstemning.

---

## 8. Rå referencer (til den der graver videre)

**Frontend:**
- `shared/indkob.js` (~3100 linjer, prefix `_ib`) — hovedkomponent. `initIndkob()`, `_ibLoadAll()`,
  `_ibBuildGroups()`, `_ibRenderCombined()` (kategori), `_ibRenderGroup()` (leverandør),
  `_ibRenderItem()` (chips), `_ibSortBarcodes()`, `_ibGotoCart()`, `_ibConfirmManualOrder()`,
  `_ibOpenDrawer()` (opret/kobl), `_ibCheckDropsize()`.
- `shared/indkob_settings.js` (~1900 linjer, prefix `_is`) — Leverandører/Produkter/Hørkram/Duplikater.
  Udgået-detection: `_isHkCheckDead()`, `_isHkBatchPriceUpdate()`.
- `kitchen/purchasing.html` (3-tab shell) · `office/index.html` (5-pill sektion).

**Backend:**
- `routes/purchasing.js` (`/api/purchasing`) — leverandører, grocy-location-kobling, supplier-mail.
- `routes/horkram.js` (`/api/horkram`) — den aktive Hørkram-proxy.
- `routes/orders.js` (`/api/orders`) — `purchase_orders` CRUD + PO-mail.
- `routes/grocy.js` (`/api/grocy`, shopping-list-delen) — `shopping-list/*`, `product-barcodes/*`.
- `services/grocyAdapter.js` — `getShoppingList`, `updateShoppingListItem`, `createProductBarcode`,
  `addShoppingListProduct`.
- `services/hokaParser.js` — normaliserer Hoka-data (`parseSnapshotToSummary`).
- ⚠️ `services/hokaAdapter.js` — **død kode**, ikke wired ind nogen steder.

**Migrations:** 005 (purchasing fundament), 030 (purchasing_v2 + supplier_grocy_locations),
031 (duplicate_candidates), 032 (intern-type + RR Produktion), 034 (PO-mail), 035 (goods_receipts).

---

## 9. Til restruktureringssamtalen — de åbne spørgsmål

Materiale til at strukturere modulet om (fx på claude.ai). Ikke svar — spørgsmål:

1. **Hvad er de reelle arbejdsgange?** Fast ugentlig genbestilling vs. engangskøb vs.
   erstatning-af-udgået vs. "jeg mangler akut X" — modellen dækker kun den første godt.
2. **Skal "bestillinger" være et ægte, selvstændigt overblik** (hvad er afsendt, status, hvornår
   leveres) adskilt fra "indkøbslisten" (hvad skal købes)? Eller er sammenlægningen fra 6h-revisionen
   den rigtige — og skal navngivningen så bare rettes?
3. **Hvor skal udgået-status leve?** På indkøbslisten proaktivt? Og hvordan finder man en erstatning
   — automatisk forslag via Hørkram-søgning, eller manuelt?
4. **Hvordan bestiller man en vare der ikke er på listen** uden at skulle koble den til Grocy først?
5. **Skal leveringsdato/cutoff håndhæves hos os** (advar/blokér før kurven), i stedet for at lade
   Hoka afvise bagefter?
6. **Skal de tre kilder til sandhed have ét samlende overblik**, eller er den re-samling i browseren
   acceptabel?
7. **Hvad er forholdet mellem `purchase_orders` og `ordered_*`-userfields?** Skal én af dem være den
   eneste sandhed om "bestilt"?

---

*Skrevet juli 2026. Beskriver koden på branch `claude/indkobsmodul-struktur`. As-is — ikke to-be.*
