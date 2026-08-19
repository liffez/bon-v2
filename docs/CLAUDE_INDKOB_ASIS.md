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
>
> **Livscyklussen for én vare** er den røde tråd i dokumentet:
> ```
> behov opstår (§5)  →  vises/grupperes (§2-4)  →  bestilles (§6)  →  modtages (§7)  →  væk fra listen
> ```
> Indstillinger (§9), forecast (§10) og leverandørpost (§11) er sidespor omkring sløjfen.

---

## 1. Grundmodel: tre kilder til sandhed

Modulet har bevidst **tre** steder data bor. At forstå denne opdeling er nøglen til alt andet.

| Kilde | Ejer | Indhold |
|-------|------|---------|
| **Grocy** | ekstern | Selve indkøbslisten (`shopping_list`), produkter, lager, barcodes, enheds-konverteringer |
| **Bon-DB (SQLite)** | os | Leverandør-metadata, leverandør↔Grocy-kobling, afsendte bestillinger (`purchase_orders`), mail-tråde, modtagelser (`goods_receipts`) |
| **Hørkram (hoka.dk)** | ekstern | Live priser, CO₂, aftale-status, salgsenheder, selve kurven. Hentes on-demand, persisteres ikke |

**Konsekvens:** en enkelt vare på indkøbslisten samler data fra alle tre. Behovet kommer fra
Grocy (`shopping_list`-linje), leverandør-kandidaterne kommer fra Grocy `product_barcodes`
+ Bon-DB's leverandør-kobling, og pris/CO₂/udgået-status kommer live fra Hørkram. Der er
ingen ét-sted-overblik — billedet samles først i browseren.

### To døde/ubrugte spor (rydder op i forvirringen)
- **`services/hokaAdapter.js` er død kode.** Den er ikke koblet til nogen route. Den aktive
  Hørkram-integration er den selvstændige `routes/horkram.js`. Adapteren indeholder bl.a. en
  `submitOrder()` + dropsize-tjek der *aldrig kaldes* — hvilket kan forlede en til at tro at
  systemet selv afgiver ordrer. Det gør det ikke (se §6).
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
| `ordered_at` | ISO-timestamp | Ved bestilling. **En vare regnes som "bestilt" når dette er sat.** Ryddes ved fortryd + ved modtagelse |
| `ordered_qty` | Bestilt antal | Ved bestilling |
| `ordered_supplier` | Leverandørens navn | Ved bestilling. **Det er DENNE værdi varemodtagelsen matcher på** (§7) |
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

Priser importeres separat til **produktets** userfields (ikke barcoden): `supplier_price_per_kg`
+ `price_updated_at` (se §9, Hørkram-tab).

Koblingen barcode → leverandør går via `shopping_location_id` → `supplier_grocy_locations` → `suppliers`.

### Bon-DB
- **`suppliers`** — `integration_type` (api/webshop/email/manual/intern), `contact_email`,
  `webshop_url`, `api_config_json` (findes i skemaet, men har **intet UI-felt** — se §9).
- **`supplier_grocy_locations`** — kobler én Grocy shopping_location → én leverandør
  (`UNIQUE(grocy_location_id)`). En leverandør kan have flere locations (fx Inco Valby + Frederiksberg).
- **`purchase_orders` + `purchase_order_lines`** — afsendte bestillinger. Status hårdkodes til
  `'sent'` ved oprettelse.
- **`goods_receipts` + `goods_receipt_items`** — modtagelser (§7). Kobler til Grocy `shopping_list`
  direkte, **ikke** til `purchase_orders`.
- **`duplicate_candidates`** — logges når samme Hørkram-varenr bruges af flere produkter (§9, tab 4).

---

## 5. Hvor kommer behovet fra — funnel-indgangen

Før en vare kan bestilles, skal den *på* Grocys `shopping_list`. Det sker fra **mindst 8 steder
i koden** — og kun ét af dem er "indkøbsmodulet selv". Det betyder at når man står med listen,
er der ingen fælles måde at vide *hvorfor* en given vare er der.

Der bruges **to forskellige backend-endpoints** til at lægge på listen (samme mål, historisk splittelse):
- `POST /api/grocy/shoppinglist` — bulk `{product_id, amount, note}`
- `POST /api/grocy/shopping-list/add-product` — enkelt `{product_id, product_amount, list_id}`

| # | Kilde | Hvor | Endpoint |
|---|-------|------|----------|
| 1 | **🛒 fra en bon** (ingrediens-mangel i Råvarer-modalen) | `shared/modal.js` `showRavarer` | `POST /grocy/shoppinglist` |
| 2 | **"Manglende (N)"-panel** (under Grocy min-lager) | `shared/indkob.js` | `POST /grocy/shopping-list/add-product` |
| 3 | **"Udløbende (N)"-panel** (udløber/overskredet) | `shared/indkob.js` | `POST /grocy/shopping-list/add-product` |
| 4 | **Manuel "+ Tilføj vare"** | `shared/indkob.js` | `POST /grocy/shopping-list/add-product` |
| 5 | **Opret/kobl-drawer** (nyt produkt/kobling) | `shared/indkob.js` | `POST /grocy/shopping-list/add-product` |
| 6 | **Lageroptælling** (optalte manglende varer) | `shared/inventory_check.js` | `POST /grocy/shoppinglist` |
| 7 | **Lageroversigt** | `shared/stock_overview.js` | `POST /grocy/shoppinglist` |
| 8 | **Opskrifts-viser/-designer** (råvarer fra opskrift) | `shared/recipe_viewer.js`, `recipe_designer.js` | `POST /grocy/shoppinglist` |

**Vigtige fund:**
- **Behov fra bons går kun via 🛒 i Råvarer-modalen** (kilde 1). Planlægning, event og
  ugeoversigt lægger *ikke* selv noget på listen — man skal manuelt åbne Råvarer-modalen på en bon
  og trykke 🛒. Der er ingen "generér indkøb ud fra ugens bons"-knap.
- **Panelerne "Manglende"/"Udløbende"** fodres af `GET /grocy/stock/volatile?due_soon_days=5`
  (Grocys min-lager + udløbsdatoer). Forslaget er `ceil(min − lager)`.
- **Grocy's egne bulk-endpoints** `add-missing`/`add-expired`/`add-overdue` er **defineret men
  bruges ingen steder i UI'et** — man bruger den granulære per-produkt-vej i stedet (så brugeren
  vælger antal). De ligger som død overflade i `api.js`.

Efter indsættelse mister `shopping_list`-linjen al viden om *hvorfor* den kom på — der er intet
"kilde"-felt. En vare fra en bon-mangel og en vare fra en fysisk optælling ser ens ud på listen.

---

## 6. Flowet — fra behov til bestilling

```
Grocy shopping_list   →   _ibBuildGroups   →   leverandør-/kategori-visning   →   chips pr. vare
   (behovet, §5)           (gruppér)              (§2/§3)                         (§4)
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

## 7. Varemodtagelsen lukker sløjfen

Varemodtagelsen (`shared/varemodtagelse.js` + `routes/goods-receipts.js`) er dér en bestilt vare
bliver **modtaget og fjernet fra listen**. Det er lukke-trinnet i livscyklussen — men det lever i
en **helt anden tab** (Varemodtagelse), ikke koblet visuelt til bestillingen.

### To sektioner, touch-first
1. **Fødevarekontrol:** bruger-dropdown → (evt. modtagedato) → leverandør → temperaturer (køl/frys,
   3-niveau status ok/OBS/AFV.) → 3 FVST-toggles (dato/mærkning/emballage) → foto → afvigelse.
2. **Lager:** vareliste med "Godkend alt" eller "Juster enkeltvis". Per-vare status:
   ok / mangler / forkert / beskadiget + modtaget mængde.

### Hvor varelinjerne kommer fra — og hvad status gør
- Varelinjerne hentes ved at **matche Grocy `shopping_list` på `ordered_supplier` + `ordered_varenr`**
  for den valgte leverandør (dvs. kun *bestilte* varer for den leverandør). Leverandør-dropdownen
  viser "\<navn\> — N varer klar".
- Per-vare status → hvad der sker med Grocy (serverside i `goods-receipts.js`, jf. tidligere kortlægning):
  - **Fuld levering** (`received >= expected`) → `addStock` + **slet** shopping_list-linjen
  - **Delvis** (`received < expected`) → `addStock` + **reducér** linjens `amount` til resten + nulstil `ordered_*`
  - **Mangler** (`missing`/qty 0) → nulstil `ordered_*`, **behold** på listen
- Grocy-fejl vælter aldrig en modtagelse (partial-success → status `partially_approved`).

### Vigtige strukturelle fund
- **Modtagelsen er IKKE koblet til `purchase_orders`.** Den rydder op i Grocy `shopping_list`
  direkte via `shopping_list_id` — den rører aldrig PO'en. Så "bestilt" (PO + `ordered_*`) og
  "modtaget" (`goods_receipts`) er to adskilte spor der aldrig mødes. En PO forbliver `sent` for evigt.
- **Ad-hoc-modtagelse:** man kan vælge "➕ Andet — skriv selv…" og tilføje varer manuelt
  (`prompt`-dialoger). Ad-hoc-varer med et Grocy-produkt lægges på lager; varer helt uden for Grocy
  gør ikke (kommentar i koden: de hører til lageroptælling, ikke varemodtagelse).
- **Bruger gemmes kun som navn** (`received_by_name`), ikke som id — snapshot, ikke FK. Dropdown
  merger lokale `staff` + Smartplan-ansatte (dedup på navn).
- **Backdatering** af modtagedato kræver admin eller permission `modtag_backdate`.
- Whiteboard notificeres via fire-and-forget webhook (link-only foto).

---

## 8. Hørkram-integrationen

- Selvstændig proxy i `routes/horkram.js` (ikke `hokaAdapter.js`). Logger ind på hoka.dk med
  firmaets rigtige credentials, cacher session 30 min, re-logger automatisk ved 401/403.
- **Snapshots** (`/snapshots?ids=`): batch-henter live pris/CO₂/aftale-status/salgsenheder for op
  til 60 varenumre ad gangen (chunkes i 20). Alle kald bruger leveringsdato = **i morgen**, hårdkodet.
- **Kurv** (`PUT /basket/add`): Hoka erstatter HELE kurven ved hvert PUT, så vi henter eksisterende
  linjer og merger. Kræver anti-forgery-token. Håndterer at Hoka bruger `SalesUnitIndex` (ikke code).
- **Aftale-status** udledes af `SalesPriceSource.TrackingId === 'Fixed'` i snapshot-svaret.
- **Udgået-detektion** er ikke et Hoka-flag — vi udleder "død" af *fravær* i snapshot-svaret (§9).

---

## 9. Indstillingerne — vedligeholdelsessporet

`shared/indkob_settings.js` (`initIndkobSettings`, prefix `_is`). Monteres to steder: køkkenets
tandhjuls-slide-in (`mode:'panel'`) og office-pill'en "Leverandører" (`mode:'page'`). **Her lever
halvdelen af det reelle arbejde** — og bl.a. udgået-detektion og pris-import. 4 tabs:

### Tab 1 — Leverandører
CRUD på `suppliers` (via `routes/purchasing.js`). Redigerbare felter: navn, integration_type,
bestillingsmail (`contact_email`), telefon, webshop_url, noter. Nederst: Grocy-location-kobling med
**auto-save** (vælg leverandør i dropdown → gemmes straks; 409 ved dublet). Soft-delete (`is_active=0`).
- **Uoverensstemmelser:** `integration_type='form'` er gyldig i backend men mangler i frontend-dropdownen.
  `api_config_json` findes i skemaet men har **intet UI-felt** — kun 6 felter kan redigeres.

> **Opdateret 19.08.2026 (#477):** koblingen har nu også et **visningsnavn**-felt
> (`supplier_grocy_locations.display_name` via `PATCH /api/purchasing/suppliers/grocy-locations/:id`).
> Feltet har eksisteret siden migration 030 og blev allerede brugt af label-opløsningen, men kunne
> før kun sættes med SQL. Det er dét der gør at en gruppe kan hedde "Serviwet" selvom den ligger på
> Grocy-lokationen "Emballage" — en fælles kanal for flere emballage-leverandører. Placeholder =
> Grocy-navnet, så tomt felt er tydeligt. Samme sted: leverandørtabellen skrev "Lok 2 / Lok 5 /
> Lok 9" og viser nu lokationsnavnene (Hørkram · Drikkevarer · Convifood), hvilket samtidig gør
> synligt at én leverandør kan dække flere kanaler.

### Tab 2 — Produkter (batch-editor)
Konfigurerbar tabel over Grocy-produkter med kolonne-chips (præferencer i localStorage
`ib_settings_product_cols`). Filter på søgning + leverandør. Redigerbare felter pr. produkt:
- **Leverandør** (`shopping_location_id`) og **min. grænse** (`min_stock_amount`).
- Dirty-tracking + bulk-save (5 samtidige `PUT /grocy/products/:id`). **Gemmer til native
  Grocy-produktfelter** — ikke userfields, ikke barcodes. Min-grænsen her er præcis den der driver
  "Manglende"-panelet i §5.

### Tab 3 — Hørkram (4 sub-tabs)
- **Opslag:** smart søg (tal → direkte varenr-opslag, tekst → søgning). Produktkort med "Kobl til
  Grocy-produkt" (opret barcode + sæt userfields, F13 pack-size-guard advarer ved divergens) og
  "Opdater pris" (henter `pricePerKg` → produktets userfields).
- **Favoritter:** Hoka-favoritlister. **"Importer priser"** = batch-snapshot af alle varenumre →
  skriver `supplier_price_per_kg` + `price_updated_at` til Grocy-produkterne (kun for allerede
  koblede varer).
- **Ny kobling:** Grocy-produkter uden HK-barcode. Auto-søg med confidence-score (Dice/bigram:
  >0.85 høj/grøn, >0.6 medium/gul). Kobling opretter barcode. Sætter *ikke* userfields her.
- **Alle koblinger:** tabel over alle HK-barcodes grupperet pr. produkt. Foretrukket-toggle, slet,
  "+ Vare variant" (koble flere pakstørrelser til samme produkt). **HER bor "Udgået" (§7.4-smerten):**

> **Udgået-detektion (as-is):** to veje, samme mekanik — *fravær i snapshot-svar = død*.
> (1) "Tjek udgåede"-knap, eller (2) side-effekt af "↻ Opdater priser nu". Begge batcher alle
> HK-varenumre gennem `/snapshots` i chunks à 20 og markerer varenumre der **ikke** kom tilbage
> som døde. Ved fetch-fejl markeres intet (konservativt: "vi ved det ikke").
>
> `_isDeadBarcodes` er **ren, ikke-persisteret client-state** — det forsvinder ved reload og skal
> genberegnes hver gang. Det vises kun her i "Alle koblinger" (rød række + "Udgået"-badge),
> **aldrig på selve indkøbslisten**.

### Tab 4 — Duplikater
Duplikat-kandidater = samme Hørkram-varenr koblet på flere Grocy-produkter. Logges automatisk ved
bestilling. Tabel med status-badges (afventer/merget/ikke-duplikat/ignoreret) + tre action-knapper.

> **As-is-fælde:** knappen **"✓ Merget" sætter bare status = `merged`** — den udfører ikke selve
> Grocy-merge. Det er en manuel markering; den faktiske sammenlægning skal ske et andet sted (i Grocy).

---

## 10. Forecast — en isoleret ø

`office/views/forecast.js` + `GET /api/purchasing/forecast`. Viser forventet råvarebehov i en
fremtidig periode, grupperet pr. leverandør — tænkt som et "heads-up" man kan sende leverandøren.

**Beregning (backend):**
- **Sæson (primært):** samme periode sidste år (from/to skubbet −364 dage, så ugedage flugter).
- **Fallback:** hvis < 3 bons i sæson-vinduet → rullende 8-ugers snit, skaleret. Markeret `used_fallback`.
- **Booket ovenpå:** allerede-bookede fremtidige bons i vinduet. `forecast = max(historisk, booket)`.
- Datagrundlag: interne `bon_lines.grocy_recipe_id` → råvarer via `ingredientResolver` (Grocy).
  Produkt→leverandør via `shopping_location_id`.

**Handlinger:** kun (a) "📋 Kopiér liste" (tekst til clipboard) og (b) "✉ Skriv til leverandør"
(deep-link til Leverandørpost).

> **Nøglefund:** **Forecast fodrer IKKE indkøbslisten.** Der er ingen "læg forecast på listen"-handling.
> Forecast rører aldrig `shopping_list`, `bon_lines` eller purchase orders — det er ren læsning +
> kopier/mail. Det er en analytisk ø ved siden af selve indkøbet.
>
> Deep-linket "Skriv til leverandør" er endda **blødt/ødelagt:** det sætter `?supplier_mail=<id>`,
> men den parameter læses kun af *indkøbsliste*-viewet, ikke af Leverandørpost-viewet. Så knappen
> åbner bare Leverandørpost-fanen og beder via toast brugeren om selv at finde leverandøren og
> indsætte den kopierede liste.

---

## 11. Leverandørpost

`shared/supplier_inbox.js`. To-kolonne inbox (trådliste + preview/svar). Genbruges som "Post"-tab
i køkkenet og "Leverandørpost"-pill i office.

Kombinerer **to trådtyper** i én liste:
- **PO-tråde** (`GET /api/orders/mail-threads`) — mail knyttet til en purchase order. Mærket 📦.
- **Fri leverandør-mail** (`GET /api/purchasing/suppliers/mail-overview`) — tråde uden PO. Mærket ✉.

Kategori-filter: Alle typer / 📦 Bestillinger / ✉ Generel + læst/ulæst. Svar routes efter trådtype
(PO → `sendOrderReply`, supplier → `sendSupplierMail` via `smtp_kontakt`). Ulæst-badge samles i
`GET /api/nav/badges` (`indkob_leverandorpost`) og driver både pill-badge og Post-tab-badge.
SSE (`po_mail_*`, `supplier_mail_*`) re-loader listen live.

---

## 12. Smertepunkterne — hvor grundmodellen knækker

Dette er kernen i hvorfor en restrukturering er nødvendig. De fire driftsproblemer brugeren
oplever peger alle på **samme rod**: modulet er optimeret til *fast genbestilling ud fra Grocys
minimumsgrænser*. Det knækker på undtagelserne.

### 12.1 Kan ikke nemt bestille ét bestemt varenummer i en bestemt mængde
**Oplevelse:** "jeg skal kun købe ét bundt af varenummer 60034742, men det kan jeg ikke tilføje."

**Rod:** der er ingen ren "smid denne præcise leverandør-vare + mængde i kurven"-vej. De to
tilføj-knapper gør noget andet:
- **"+ Tilføj vare"** søger *kun i eksisterende Grocy-produkter* (lokalt cache) — ikke i Hørkram-katalog.
- **"+ Opret/kobl"** er til at *koble et Hørkram-varenummer til et Grocy-produkt* (opret barcode),
  ikke til at bestille direkte.

Modellen forudsætter at alt går gennem "Grocy siger vi mangler → foreslå leverandør-vare". Et
rent engangskøb ("jeg vil bare have dette ene bundt") har ingen naturlig indgang.

> **Delvist afhjulpet 19.08.2026 (#477)** — for *koblingen*, ikke for engangskøbet. Kobl-panelet
> i en leverandørgruppe kan nu gemme leverandørens **eget** varenummer eller faste betegnelse som
> fri tekst (fx "Hvide servietter 33x33"), i stedet for at eneste virkende vej var et opdigtet
> INT-nummer. `_ibLinkBarcode` gætter ikke længere leverandøren ud fra om nummeret er numerisk.
> Man kan desuden nu rette, slette og markere foretrukket **direkte på listen** — det lå før kun i
> Indstillinger → Hørkram → "Alle koblinger" (§9).
>
> Selve engangskøbet — bestil en vare uden at den først skal være et *behov* i Grocy — er uændret
> og hører til Fase C. Og `Uden leverandør`-blokken bruger stadig `+ Opret/kobl`-draweren med den
> gamle numeriske Hørkram-regel; rettes som del af A9.

### 12.2 Tilføjede varer fejler — leveringsdato + kurv-format
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

### 12.3 "Bestillinger" viser ikke hvad man har bestilt
**Oplevelse:** "hvad er forskellen på bestillinger og indkøbsliste — ved bestillinger burde man
gerne kunne se hvad man har bestilt."

**Rod (jf. §2):** i office er "Bestillinger" og "Indkøbsliste" *samme* komponent, samme view.
Der findes ikke et selvstændigt "det her har jeg bestilt"-overblik. Dataen findes
(`ordered_*`-userfields + `purchase_orders`-tabellen), men den er kun synlig som en kollapset
"Bestilt"-sektion i bunden af hver leverandørgruppe. Navngivningen lover noget UI'et ikke leverer.

### 12.4 Udgåede varer opdages for sent, og der er ingen erstatnings-flow
**Oplevelse:** "relativt mange produkter er udgået hos Hørkram; vi skal finde en smart måde at
finde erstatninger på — og på indkøbslisten kan man ikke se de er udgået før man går ind i
leverandøren og opdaterer priserne."

**Rod:**
- Udgået-status detekteres **kun** i Indstillinger → Hørkram → "Alle koblinger" (§9), via "Tjek
  udgåede" eller batch-prisopdatering. Signalet er svagt: en vare regnes som udgået hvis den
  *mangler* i snapshot-svaret (fravær = død). Der er intet eksplicit "udgået"-flag fra Hoka.
- Statussen er **ikke-persisteret client-state** — den forsvinder ved reload og vises **ingen andre
  steder end netop den tabel**. Aldrig på selve indkøbslisten.
- Der er **intet erstatnings-flow** overhovedet — ingen "find lignende vare" når noget er udgået.

### 12.5 Varemodtagelsen matcher på leverandørens navn — ikke på et id

**Rod:** `_vmBuildItemsFromShoppingList()` bygger varelisten ved at matche Grocys
`shopping_list` på userfields `ordered_supplier` + `ordered_varenr` (§4, §7).
`ordered_supplier` er leverandørens **navn** som fritekst. Det samme gælder
`goods_receipts.supplier_name`, der også er en streng uden FK til `suppliers`.

Leverandørnavnet er frit redigerbart i Indstillinger → Tab 1 (§9).

**Konsekvens ved omdøbning med udestående bestillinger:**
- Varemodtagelsens leverandør-dropdown viser "0 varer klar" for den leverandør
- De bestilte varer lægges aldrig på lager
- `ordered_*` nulstilles aldrig, så linjerne bliver hængende som "bestilt" på
  indkøbslisten og bestilles ikke igen — men de kommer heller aldrig ind
- Der udløses ingen fejl noget sted. Tabet er tavst

Samme problem opstår ved stavevariation mellem leverandørnavnet i `suppliers` og
det navn der blev skrevet i `ordered_supplier` på bestillingstidspunktet — de to
kan divergere uden at nogen opdager det.

**Bemærk rækkefølgen:** dette er også en binding på Fase C. Beslutningen om at
`purchase_order_lines` bliver eneste sandhed om "bestilt", og at `ordered_*`
degraderes til en projektion vi skriver men aldrig læser, kan ikke gennemføres
alene. Varemodtagelsen *læser* `ordered_*` — ikke kun til oprydning, men til at
bygge selve varelisten. De to moduler skal migreres i samme deploy.

> Rettes i `indkob/CLAUDE_INDKOB_FASE_A.md` §10 (A7). Sporet som issue #461.

### 12.6 Yderligere strukturelle observationer (fundet under kortlægningen)
- **Behov lander fra 8 steder uden fælles model (§5).** En vare på listen bærer ingen viden om
  *hvorfor* den er der (bon-mangel? optælling? manuel?). Der er intet "kilde"-felt. Det gør det svært
  at ræsonnere om listen og umuligt at spore et behov tilbage til dets ophav.
- **Behov fra bons kræver manuel 🛒 pr. bon.** Der er ingen "generér ugens indkøb ud fra bookede
  bons"-vej — planlægning/event/ugeoversigt fodrer ikke listen.
- **Bestilling og modtagelse er koblet fra hinanden (§7).** `purchase_orders` opdateres aldrig ved
  modtagelse; varemodtagelsen rydder Grocy `shopping_list` direkte. To spor der aldrig mødes → en PO
  står `sent` for evigt, og der er ingen afstemning "bestilt vs. faktisk modtaget".
- **Bestilt-status lever to steder** (`purchase_orders` + `ordered_*`-userfields) uden at én er
  autoritativ. De kan divergere.
- **Forecast er en isoleret ø (§10)** der ikke fodrer listen, og hvis eneste handling (deep-link)
  er halvt ødelagt.
- **Død kode + halve funktioner forvirrer:** `hokaAdapter.js` (`submitOrder` antyder auto-bestilling),
  Bon-DB's ubrugte `shopping_list`-tabel, "Merget"-knappen der ikke merger, `add-missing/expired/overdue`
  der aldrig kaldes, `integration_type='form'`/`api_config` uden UI, health-felt-mismatch (session-tid
  vises aldrig).
- **To shells med forskellige tabs** (køkken 3-tab vs office 5-pill) → "hvor gør jeg X" afhænger af zone.

- **Leverandør refereres ved navn tre steder** (`ordered_supplier`,
  `goods_receipts.supplier_name`, matchningen imellem dem) uden FK til `suppliers`.
  Se 12.5.
- **Salgsenheden vælges aldrig af brugeren.** Frontenden sender altid
  `salesUnits[0]`, som ikke er Hokas default. For varer hvor kartonen listes først,
  bestilles der i kartoner uden at nogen har valgt det — og enheden persisteres
  i Grocys `supplier_unit_*`-userfields. Se `indkob/CLAUDE_INDKOB_FASE_A.md` §1.1.
- **`ordered_qty` bærer ingen enhed.** Varemodtagelsen sammenligner modtaget mod
  `ordered_qty` uden at vide om tallet tæller kartoner eller poser (§7).

---

## 13. Rå referencer (til den der graver videre)

**Frontend:**
- `shared/indkob.js` (~3100 linjer, prefix `_ib`) — hovedkomponent. `initIndkob()`, `_ibLoadAll()`,
  `_ibBuildGroups()`, `_ibRenderCombined()` (kategori), `_ibRenderGroup()` (leverandør),
  `_ibRenderItem()` (chips), `_ibSortBarcodes()`, `_ibGotoCart()`, `_ibConfirmManualOrder()`,
  `_ibOpenDrawer()` (opret/kobl), `_ibCheckDropsize()`, `_ibLoadVolatile()` (Manglende/Udløbende).
- `shared/indkob_settings.js` (~1900 linjer, prefix `_is`) — Leverandører/Produkter/Hørkram/Duplikater.
  Udgået-detection: `_isHkCheckDead()`, `_isHkBatchPriceUpdate()`.
- `shared/varemodtagelse.js` (prefix `_vm`) — varemodtagelse. `_vmBuildItemsFromShoppingList()`
  (match mod `ordered_*`), `_vmRenderLagerContent()`.
- `shared/supplier_inbox.js` — leverandørpost. `shared/modal.js` `showRavarer` (🛒-behov fra bon).
- `office/views/forecast.js` — forecast-viewet.
- `kitchen/purchasing.html` (3-tab shell) · `office/index.html` (5-pill sektion).

**Backend:**
- `routes/purchasing.js` (`/api/purchasing`) — leverandører, grocy-location-kobling, supplier-mail, `/forecast`.
- `routes/horkram.js` (`/api/horkram`) — den aktive Hørkram-proxy.
- `routes/orders.js` (`/api/orders`) — `purchase_orders` CRUD + PO-mail.
- `routes/goods-receipts.js` (`/api/goods-receipts`) — varemodtagelse: addStock + shopping_list cleanup.
- `routes/grocy.js` (`/api/grocy`, shopping-list-delen) — `shopping-list/*`, `product-barcodes/*`, `stock/volatile`.
- `routes/settings.js` — `/duplicates*`. `routes/nav.js` — `/badges` (ulæst leverandørpost).
- `services/grocyAdapter.js` — `getShoppingList`, `updateShoppingListItem`, `createProductBarcode`,
  `addShoppingListProduct`, `addToStock`.
- `services/ingredientResolver.js` — råvare-opløsning (bruges af forecast + Råvarer-modal).
- `services/hokaParser.js` — normaliserer Hoka-data. `services/packSizeGuard.js` — F13-advarsel.
- ⚠️ `services/hokaAdapter.js` — **død kode**, ikke wired ind nogen steder.

**Migrations:** 005 (purchasing fundament), 030 (purchasing_v2 + supplier_grocy_locations),
031 (duplicate_candidates), 032 (intern-type + RR Produktion), 034 (PO-mail), 035/036 (goods_receipts),
037-039 (staff).

---

## 14. Til restruktureringssamtalen — de åbne spørgsmål

Materiale til at strukturere modulet om (fx på claude.ai). Ikke svar — spørgsmål:

1. **Hvad er de reelle arbejdsgange?** Fast ugentlig genbestilling vs. engangskøb vs.
   erstatning-af-udgået vs. "jeg mangler akut X" — modellen dækker kun den første godt.
2. **Skal behov have ét fælles spor?** Skal en `shopping_list`-linje bære *hvorfor* den er der
   (bon-mangel / optælling / manuel), så man kan spore og forstå listen — i stedet for 8 anonyme kilder?
3. **Skal "bestillinger" være et ægte, selvstændigt overblik** (hvad er afsendt, status, hvornår
   leveres, modtaget?) adskilt fra "indkøbslisten" (hvad skal købes)? Eller er sammenlægningen fra
   6h-revisionen den rigtige — og skal navngivningen så bare rettes?
4. **Skal bestilling og modtagelse kobles?** Skal `purchase_orders` opdateres når varer modtages, så
   der findes en afstemning "bestilt vs. modtaget" og PO'en ikke står `sent` for evigt?
5. **Hvor skal udgået-status leve?** På indkøbslisten proaktivt (og persisteret)? Og hvordan finder
   man en erstatning — automatisk forslag via Hørkram-søgning, eller manuelt?
6. **Hvordan bestiller man en vare der ikke er på listen** uden at skulle koble den til Grocy først?
7. **Skal leveringsdato/cutoff håndhæves hos os** (advar/blokér før kurven), i stedet for at lade
   Hoka afvise bagefter?
8. **Skal forecast kunne fodre indkøbslisten** (fx "læg forventet behov på listen"), eller forbliver
   det ren information?
9. **Hvad er den autoritative sandhed om "bestilt"** — `purchase_orders` eller `ordered_*`-userfields?
10. **Skal de tre kilder til sandhed have ét samlende overblik**, eller er den re-samling i browseren
    acceptabel?
11. **Skal leverandør refereres ved id i stedet for navn** i `ordered_supplier` og
    `goods_receipts.supplier_name`, så en omdøbning ikke taber udestående bestillinger? (§12.5)

> **Spørgsmål 2 og 8 er ét spørgsmål.** Uden et kildefelt på `shopping_list`-linjen kan forecast
> aldrig skrive til listen forsvarligt — to kørsler kan ikke skelnes fra hinanden, og der er intet
> at afstemme mod. Med `source` + `source_ref` bliver et forecast-push idempotent: slet mine egne
> tidligere forecast-linjer i vinduet, skriv de nye, rør intet andet.
>
> De beholder deres numre, fordi `indkob/CLAUDE_INDKOB_FASE_B.md` og
> `indkob/HUSKELISTE_indkob_fase_c.md` refererer til dem som "spm. 2 + 8".

---

*Skrevet juli 2026, udvidet med varemodtagelse, behovskilder, indstillinger, forecast og leverandørpost.
Beskriver koden på branch `claude/indkobsmodul-struktur`. As-is — ikke to-be.*
